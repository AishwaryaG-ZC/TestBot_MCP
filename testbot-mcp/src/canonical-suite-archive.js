'use strict';

/**
 * CL3-C — minimal store-only ZIP writer.
 *
 * The worker needs to package the accepted test suite into a downloadable
 * zip without adding a new dependency to testbot-mcp's package.json. Pure
 * Node's `zlib.deflateRawSync` plus a hand-rolled PK header gives us a
 * spec-compliant ZIP that any consumer (browser unzipper, OS Archive
 * Manager, `unzip` CLI) can extract.
 *
 * The output is intentionally simple:
 *   - one Local File Header + DEFLATE-compressed payload per entry
 *   - one Central Directory File Header per entry
 *   - one End of Central Directory (EOCD) record
 *   - no Zip64, no encryption, no extra fields
 *
 * Test suites are <2MB so the simple format is more than enough.
 *
 * Exports:
 *   buildSuiteArchive({ files: [{ path, content }] }) → { archiveB64, archiveBytes }
 *
 *   `path` is the in-zip filename (forward slashes; no leading `/`).
 *   `content` is a string OR a Buffer.
 */

const zlib = require('zlib');
const crypto = require('crypto');

// CRC-32 (used by ZIP for per-entry payload integrity). Pure JS so we don't
// pull a native dep. Polynomial 0xEDB88320 — IEEE 802.3.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Compose a DOS timestamp (date+time) from a JS Date. ZIP stores these as
// little-endian uint16s. We default to a stable epoch so the same input
// always produces the same zip — useful for test snapshots.
function dosDateTime(date) {
  const d = date || new Date('2026-01-01T00:00:00Z');
  const year = Math.max(1980, d.getUTCFullYear());
  const dosDate =
    ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const dosTime =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  return { dosDate: dosDate & 0xFFFF, dosTime: dosTime & 0xFFFF };
}

function asBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content == null) return Buffer.alloc(0);
  return Buffer.from(String(content), 'utf8');
}

function normalizeEntryPath(p) {
  if (typeof p !== 'string') throw new Error('canonical-suite-archive: entry path must be a string');
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('/')) out = out.slice(1);
  if (out.length === 0) throw new Error('canonical-suite-archive: entry path is empty');
  if (out.length > 1024) throw new Error('canonical-suite-archive: entry path too long');
  return out;
}

/**
 * Build a zip archive in-memory and return its base64 string and byte count.
 *
 * @param {Object} args
 * @param {Array<{path: string, content: string|Buffer}>} args.files
 * @param {Date}   [args.mtime]  Optional mtime to stamp all entries; defaults to a stable epoch.
 * @returns {{ archiveB64: string, archiveBytes: number, sha256: string }}
 */
function buildSuiteArchive({ files, mtime } = {}) {
  if (!Array.isArray(files)) {
    throw new Error('canonical-suite-archive: files must be an array');
  }

  const { dosDate, dosTime } = dosDateTime(mtime);
  const localBuffers = [];
  const centralBuffers = [];
  let offset = 0;

  for (const entry of files) {
    if (!entry) continue;
    const normalizedPath = normalizeEntryPath(entry.path);
    const raw = asBuffer(entry.content);
    const compressed = zlib.deflateRawSync(raw);
    // We prefer DEFLATE unless the compressed payload is larger than raw —
    // ZIP allows method=0 (store) which we use as a fallback for tiny files.
    const useStore = compressed.length >= raw.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? raw : compressed;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(normalizedPath, 'utf8');

    // Local File Header.
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);            // signature
    lfh.writeUInt16LE(20, 4);                    // version needed
    lfh.writeUInt16LE(0, 6);                     // flags
    lfh.writeUInt16LE(method, 8);                // method
    lfh.writeUInt16LE(dosTime, 10);              // mod time
    lfh.writeUInt16LE(dosDate, 12);              // mod date
    lfh.writeUInt32LE(crc, 14);                  // crc32
    lfh.writeUInt32LE(payload.length, 18);       // compressed size
    lfh.writeUInt32LE(raw.length, 22);           // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);       // name length
    lfh.writeUInt16LE(0, 28);                    // extra length
    localBuffers.push(lfh, nameBuf, payload);

    // Central Directory File Header (records the LFH offset).
    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4);                   // version made by
    cdfh.writeUInt16LE(20, 6);                   // version needed
    cdfh.writeUInt16LE(0, 8);                    // flags
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt16LE(dosTime, 12);
    cdfh.writeUInt16LE(dosDate, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(payload.length, 20);
    cdfh.writeUInt32LE(raw.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);                   // extra length
    cdfh.writeUInt16LE(0, 32);                   // comment length
    cdfh.writeUInt16LE(0, 34);                   // disk number
    cdfh.writeUInt16LE(0, 36);                   // internal attrs
    cdfh.writeUInt32LE(0, 38);                   // external attrs
    cdfh.writeUInt32LE(offset, 42);              // LFH offset

    centralBuffers.push(cdfh, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }

  const localChunk = Buffer.concat(localBuffers);
  const centralChunk = Buffer.concat(centralBuffers);

  // End Of Central Directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk where central dir starts
  eocd.writeUInt16LE(files.length, 8);            // # entries on this disk
  eocd.writeUInt16LE(files.length, 10);           // # entries total
  eocd.writeUInt32LE(centralChunk.length, 12);    // size of central dir
  eocd.writeUInt32LE(localChunk.length, 16);      // central dir offset
  eocd.writeUInt16LE(0, 20);                      // comment length

  const archive = Buffer.concat([localChunk, centralChunk, eocd]);
  const sha = crypto.createHash('sha256').update(archive).digest('hex');
  return {
    archiveB64: archive.toString('base64'),
    archiveBytes: archive.length,
    sha256: sha,
  };
}

module.exports = {
  buildSuiteArchive,
  // Exposed for tests
  _internals: { crc32, dosDateTime, normalizeEntryPath },
};
