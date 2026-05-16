'use strict';

/**
 * CL3-C — verify the in-memory ZIP writer round-trips a small fixture suite.
 *
 * We don't pull a JS unzip dep just for the test — instead we parse the
 * archive's End-Of-Central-Directory and central directory ourselves and
 * decompress each entry via zlib.inflateRawSync. That keeps the test
 * self-contained and proves both the LFH and CDFH bookkeeping is correct.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { buildSuiteArchive } = require('../src/canonical-suite-archive');

function parseZipEntries(buf) {
  // Find the EOCD record by scanning backwards (no comment so it's at len-22).
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`CDFH signature missing at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Read corresponding LFH to get the payload offset.
    if (buf.readUInt32LE(lfhOffset) !== 0x04034b50) throw new Error(`LFH signature missing at ${lfhOffset}`);
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const payloadStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const payload = buf.slice(payloadStart, payloadStart + compSize);

    let content;
    if (method === 0) {
      content = payload;
    } else if (method === 8) {
      content = zlib.inflateRawSync(payload);
    } else {
      throw new Error(`Unsupported method ${method}`);
    }
    if (content.length !== rawSize) {
      throw new Error(`Size mismatch for ${name}: ${content.length} vs ${rawSize}`);
    }

    entries.push({ name, content });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('buildSuiteArchive round-trips 3 fixture files', () => {
  const files = [
    { path: 'tests/healix-persistent/tier-0/healix-qa-contracts.spec.ts', content: "import { test, expect } from '@playwright/test';\n// tier-0\n" },
    { path: 'tests/healix-ephemeral/tier-1/login-flow.spec.ts',           content: "test('[REQ:F1.S1.AC1] login works', async () => { /* ... */ });\n" },
    { path: 'tests/healix-ephemeral/tier-1/empty.spec.ts',                content: '' },
  ];

  const { archiveB64, archiveBytes, sha256 } = buildSuiteArchive({ files });
  assert.ok(typeof archiveB64 === 'string' && archiveB64.length > 0);
  assert.ok(archiveBytes > 0);
  assert.equal(typeof sha256, 'string');
  assert.equal(sha256.length, 64);

  const buf = Buffer.from(archiveB64, 'base64');
  assert.equal(buf.length, archiveBytes);

  const entries = parseZipEntries(buf);
  assert.equal(entries.length, 3);

  const byName = new Map(entries.map((e) => [e.name, e.content.toString('utf8')]));
  assert.equal(byName.get('tests/healix-persistent/tier-0/healix-qa-contracts.spec.ts'), files[0].content);
  assert.equal(byName.get('tests/healix-ephemeral/tier-1/login-flow.spec.ts'),           files[1].content);
  assert.equal(byName.get('tests/healix-ephemeral/tier-1/empty.spec.ts'),                files[2].content);
});

test('buildSuiteArchive is deterministic for stable mtime', () => {
  const files = [
    { path: 'a.spec.ts', content: 'import { test } from "@playwright/test";\n' },
    { path: 'b.spec.ts', content: 'import { test } from "@playwright/test";\n// b\n' },
  ];
  const first = buildSuiteArchive({ files });
  const second = buildSuiteArchive({ files });
  assert.equal(first.sha256, second.sha256, 'identical inputs produce identical archive sha');
});

test('buildSuiteArchive normalizes Windows-style paths', () => {
  const { archiveB64 } = buildSuiteArchive({
    files: [{ path: 'tests\\healix-ephemeral\\tier-1\\win.spec.ts', content: 'x' }],
  });
  const entries = parseZipEntries(Buffer.from(archiveB64, 'base64'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'tests/healix-ephemeral/tier-1/win.spec.ts');
});

test('buildSuiteArchive throws on empty path', () => {
  assert.throws(
    () => buildSuiteArchive({ files: [{ path: '', content: 'x' }] }),
    /entry path is empty/i
  );
});
