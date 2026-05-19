'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

/**
 * G68: per-file artifact upload + concurrency + partial failure.
 *
 * Five cases:
 *  1. 40-file batch with all 200s → uploaded=40, failed=0, success=true
 *  2. 40-file batch with 2 failures → uploaded=38, failed=2, success=false (partial_failure)
 *  3. 1 transient 500 retried successfully → uploaded=1 (no failure surfaces)
 *  4. concurrency cap is honored (never more than N in-flight)
 *  5. credentials files are refused (deny-list belt-and-braces)
 */

// Mock node-fetch via Module._load. The mocked fetch records call timing
// so we can assert concurrency.
function withMockedFetch(handler, fn) {
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'node-fetch') {
      return handler;
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  delete require.cache[require.resolve('../src/artifact-uploader')];
  try {
    return fn();
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../src/artifact-uploader')];
  }
}

function setupTmpArtifacts(tmp, count) {
  fs.mkdirSync(tmp, { recursive: true });
  const artifacts = [];
  for (let i = 0; i < count; i++) {
    const f = path.join(tmp, `file-${i}.txt`);
    fs.writeFileSync(f, `content-${i}`);
    artifacts.push({
      fullPath: f,
      fileName: `file-${i}.txt`,
      type: 'trace', // skip image/video compression paths
      contentType: 'application/octet-stream',
      testName: `test-${i}`,
    });
  }
  return artifacts;
}

test('G68: 40-file batch — all 200s → uploaded=40, failed=0, success=true', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g68-a-'));
  let callCount = 0;
  try {
    const fakeFetch = async () => {
      callCount += 1;
      return { ok: true, json: async () => ({ uploaded: 1 }), text: async () => '' };
    };
    await withMockedFetch(fakeFetch, async () => {
      const ArtifactUploader = require('../src/artifact-uploader');
      const u = new ArtifactUploader({ apiKey: 'k', dashboardUrl: 'http://x' });
      const artifacts = setupTmpArtifacts(tmp, 40);
      const result = await u.uploadArtifacts('run-1', artifacts);
      assert.strictEqual(result.uploaded, 40);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(result.success, true);
      assert.strictEqual(callCount, 40, 'must POST exactly one request per file');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G68: 40-file batch with 2 hard failures → uploaded=38, failed=2, partial_failure', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g68-b-'));
  let callCount = 0;
  try {
    const fakeFetch = async () => {
      callCount += 1;
      // Fail file index 3 and 17 with 4xx (non-retryable)
      const i = callCount;
      if (i === 4 || i === 18) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad request' };
      }
      return { ok: true, json: async () => ({ uploaded: 1 }), text: async () => '' };
    };
    await withMockedFetch(fakeFetch, async () => {
      const ArtifactUploader = require('../src/artifact-uploader');
      const u = new ArtifactUploader({ apiKey: 'k', dashboardUrl: 'http://x' });
      const artifacts = setupTmpArtifacts(tmp, 40);
      const result = await u.uploadArtifacts('run-1', artifacts);
      assert.strictEqual(result.uploaded, 38);
      assert.strictEqual(result.failed, 2);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'partial_failure');
      assert.ok(Array.isArray(result.failureSamples));
      assert.strictEqual(result.failureSamples.length, 2);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G68: transient 5xx is retried and ultimately succeeds', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g68-c-'));
  let attempts = 0;
  try {
    const fakeFetch = async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503, text: async () => 'transient' };
      return { ok: true, json: async () => ({ uploaded: 1 }), text: async () => '' };
    };
    await withMockedFetch(fakeFetch, async () => {
      const ArtifactUploader = require('../src/artifact-uploader');
      const u = new ArtifactUploader({ apiKey: 'k', dashboardUrl: 'http://x' });
      const artifacts = setupTmpArtifacts(tmp, 1);
      const result = await u.uploadArtifacts('run-1', artifacts);
      assert.strictEqual(result.uploaded, 1);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(attempts, 2, 'should have retried once');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G68: concurrency cap is honored — never more than N in-flight', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g68-d-'));
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    const fakeFetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // give a tick so other workers actually overlap
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { ok: true, json: async () => ({ uploaded: 1 }), text: async () => '' };
    };
    await withMockedFetch(fakeFetch, async () => {
      const ArtifactUploader = require('../src/artifact-uploader');
      const u = new ArtifactUploader({ apiKey: 'k', dashboardUrl: 'http://x' });
      u.uploadConcurrency = 4;
      const artifacts = setupTmpArtifacts(tmp, 20);
      const result = await u.uploadArtifacts('run-1', artifacts);
      assert.strictEqual(result.uploaded, 20);
      assert.ok(maxInFlight <= 4, `concurrency exceeded: max=${maxInFlight} > 4`);
      assert.ok(maxInFlight >= 2, `concurrency too low: max=${maxInFlight} (no overlap happened)`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G68: credential files are refused before any upload', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g68-e-'));
  let callCount = 0;
  try {
    const fakeFetch = async () => { callCount += 1; return { ok: true, json: async () => ({}), text: async () => '' }; };
    await withMockedFetch(fakeFetch, async () => {
      const ArtifactUploader = require('../src/artifact-uploader');
      const u = new ArtifactUploader({ apiKey: 'k', dashboardUrl: 'http://x' });
      // craft a credentials file artifact + a normal artifact
      const credFile = path.join(tmp, '.healix', 'auth-state-admin.json');
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      fs.writeFileSync(credFile, '{"secret":1}');
      const normalFile = path.join(tmp, 'normal.txt');
      fs.writeFileSync(normalFile, 'ok');
      const artifacts = [
        { fullPath: credFile, fileName: 'auth-state-admin.json', type: 'trace', contentType: 'application/json', testName: 'whatever' },
        { fullPath: normalFile, fileName: 'normal.txt', type: 'trace', contentType: 'text/plain', testName: 'real' },
      ];
      const result = await u.uploadArtifacts('run-1', artifacts);
      assert.strictEqual(result.uploaded, 1, 'only the normal file should upload');
      assert.strictEqual(callCount, 1, 'credential file must not generate any POST');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
