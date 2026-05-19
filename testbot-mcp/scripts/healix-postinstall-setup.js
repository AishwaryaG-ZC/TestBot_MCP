#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { ensureLocalSetup } = require('../src/local-setup');

if (process.env.HEALIX_POSTINSTALL_SETUP === 'false') {
  process.stderr.write('[healix-mcp] postinstall setup skipped by HEALIX_POSTINSTALL_SETUP=false\n');
  process.exit(0);
}

try {
  const result = ensureLocalSetup({
    projectPath: path.resolve(__dirname, '..'),
    reason: 'postinstall',
  });
  if (!result.ok) {
    process.stderr.write(`[healix-mcp] setup completed with warnings; see ${result.manifestPath || '~/.healix/setup.json'}\n`);
  }
} catch (err) {
  process.stderr.write(`[healix-mcp] setup failed: ${err?.message || err}\n`);
  if (process.env.HEALIX_STRICT_POSTINSTALL === 'true') process.exit(1);
}
