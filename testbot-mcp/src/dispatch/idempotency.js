'use strict';

const fs = require('fs');
const path = require('path');

const DISPATCHED_FILE = '.healix/dispatched_findings.json';

function dispatchedFilePath(projectPath) {
  return path.join(projectPath, DISPATCHED_FILE);
}

function loadDispatched(projectPath) {
  const filePath = dispatchedFilePath(projectPath);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    return new Set(Array.isArray(entries) ? entries.map((e) => e.key) : []);
  } catch {
    return new Set();
  }
}

function recordDispatched(projectPath, key) {
  const filePath = dispatchedFilePath(projectPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
  entries.push({ key, dispatched_at: new Date().toISOString() });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

function hasBeenDispatched(dispatched, key) {
  return dispatched.has(key);
}

module.exports = { loadDispatched, recordDispatched, hasBeenDispatched };
