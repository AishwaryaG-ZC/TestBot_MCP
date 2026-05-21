'use strict';

const fs   = require('fs');
const path = require('path');

const { parseWsdlFile } = require('./wsdl-parser');
const { writeSoapTestFiles } = require('./soap-codegen');

/**
 * Scan projectPath for WSDL files, parse each one, and emit SoapUI XML project
 * files + Groovy scaffold scripts into outputDir.
 *
 * Mirrors the return shape of buildQaContractSpecFiles for dashboard compatibility.
 *
 * @param {{ projectPath: string, outputDir: string }} options
 * @returns {Promise<{
 *   written: boolean,
 *   writtenCount: number,
 *   filenames: string[],
 *   paths: string[],
 *   operations: number,
 *   services: string[]
 * }>}
 */
async function runSoapTier0({ projectPath, outputDir }) {
  const wsdlFiles = findWsdlFiles(projectPath);

  if (wsdlFiles.length === 0) {
    return { written: false, writtenCount: 0, filenames: [], paths: [], operations: 0, services: [] };
  }

  const allFilenames = [];
  const allPaths     = [];
  const services     = [];
  let   totalOps     = 0;

  for (const wsdlPath of wsdlFiles) {
    let parsed;
    try {
      parsed = parseWsdlFile(wsdlPath);
    } catch (err) {
      // Skip unparseable WSDL files — don't fail the pipeline
      continue;
    }

    if (!parsed.serviceName || parsed.operations.length === 0) continue;

    const serviceOutputDir = path.join(outputDir, sanitize(parsed.serviceName));
    const result = writeSoapTestFiles(parsed, serviceOutputDir);

    allFilenames.push(...result.filenames);
    allPaths.push(...result.filenames.map(f => path.join(serviceOutputDir, f)));
    services.push(parsed.serviceName);
    totalOps += parsed.operations.length;
  }

  return {
    written:      allFilenames.length > 0,
    writtenCount: allFilenames.length,
    filenames:    allFilenames,
    paths:        allPaths,
    operations:   totalOps,
    services,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Recursively find all *.wsdl files under dir, skipping node_modules and .git.
 */
function findWsdlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.wsdl')) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

function sanitize(name) {
  return (name || 'Service').replace(/[^a-zA-Z0-9_-]/g, '_');
}

module.exports = { runSoapTier0, findWsdlFiles };
