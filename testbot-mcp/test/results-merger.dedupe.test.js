const test = require('node:test');
const assert = require('node:assert/strict');

const ResultsMerger = require('../src/results-merger');

test('strict dedupe keeps tests distinct across suites/projects', () => {
  const merger = new ResultsMerger({ dedupeStrategy: 'strict' });

  const direct = {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration: 100,
    tests: [
      { file: 'tests/a.spec.ts', suite: 'suite A', title: 'works', status: 'passed', projectName: 'chromium' },
    ],
    failures: [],
  };

  const mcp = {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration: 120,
    tests: [
      { file: 'tests/a.spec.ts', suite: 'suite B', title: 'works', status: 'passed', projectName: 'firefox' },
    ],
    failures: [],
  };

  const merged = merger.mergeResults(direct, mcp);
  assert.equal(merged.total, 2);
});

test('strict artifact dedupe uses path/content type/size', () => {
  const merger = new ResultsMerger({ dedupeStrategy: 'strict' });

  const merged = merger.mergeArtifacts(
    {
      screenshots: [
        { name: 'shot.png', path: 'a/shot.png', contentType: 'image/png', size: 100 },
      ],
      videos: [],
      traces: [],
      other: [],
    },
    {
      screenshots: [
        { name: 'shot.png', path: 'b/shot.png', contentType: 'image/png', size: 100 },
      ],
      videos: [],
      traces: [],
      other: [],
    }
  );

  assert.equal(merged.screenshots.length, 2);
});
