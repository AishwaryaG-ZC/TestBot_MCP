'use strict';

const fs = require('fs');
const path = require('path');
const slack = require('./adapters/slack');
const githubIssues = require('./adapters/github-issues');
const jira = require('./adapters/jira');
const { loadDispatched, recordDispatched, hasBeenDispatched } = require('./idempotency');

const ADAPTERS = {
  slack,
  github: githubIssues,
  jira,
};

// Exported so tests can import it; not used for routing (routing is exact-match on `severity`).
const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function loadDispatchConfig(projectPath) {
  const configPath = path.join(projectPath, '.healix', 'dispatch.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

async function dispatchFindings(qaFindings, projectPath) {
  const config = loadDispatchConfig(projectPath);
  if (!config || !Array.isArray(config.adapters) || config.adapters.length === 0) {
    return { skipped: true };
  }

  const dispatched = loadDispatched(projectPath);
  const results = [];

  for (const finding of qaFindings || []) {
    if (!finding || !finding.signature) continue;
    for (const adapterCfg of config.adapters) {
      const adapter = ADAPTERS[adapterCfg.type];
      if (!adapter) continue;
      if (finding.severity !== adapterCfg.severity) continue;
      const key = `${finding.signature}:${adapterCfg.type}`;
      if (hasBeenDispatched(dispatched, key)) continue;

      const result = await adapter.dispatch(finding, adapterCfg);
      recordDispatched(projectPath, key);
      dispatched.add(key);
      results.push({ finding: finding.title, adapter: adapterCfg.type, severity: finding.severity, ...result });
    }
  }

  return { skipped: false, dispatched: results.length, results };
}

module.exports = { dispatchFindings, loadDispatchConfig, SEVERITY_ORDER };
