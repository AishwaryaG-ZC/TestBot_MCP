'use strict';

const { test } = require('node:test');
const assert   = require('assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const { runSoapTier0, findWsdlFiles } = require('../src/soap/soap-tier0');

const PATIENT_WSDL_SRC = path.join(
  __dirname, '../../compat-fixtures/pulseboard-soap/wsdl/PatientService.wsdl'
);

// ─── findWsdlFiles ──────────────────────────────────────────────────────────

test('findWsdlFiles: returns empty array for directory with no WSDLs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-tier0-'));
  try {
    const results = findWsdlFiles(dir);
    assert.deepEqual(results, [], 'should find no WSDL files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findWsdlFiles: finds a .wsdl file in a subdirectory', () => {
  const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-tier0-'));
  const subDir = path.join(dir, 'wsdl');
  try {
    fs.mkdirSync(subDir);
    fs.copyFileSync(PATIENT_WSDL_SRC, path.join(subDir, 'PatientService.wsdl'));

    const results = findWsdlFiles(dir);
    assert.equal(results.length, 1, 'should find exactly 1 WSDL');
    assert.ok(results[0].endsWith('PatientService.wsdl'), 'should be the PatientService WSDL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findWsdlFiles: skips node_modules directories', () => {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-tier0-'));
  const nodeDir  = path.join(dir, 'node_modules', 'some-pkg');
  const wsdlDir  = path.join(dir, 'wsdl');
  try {
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.mkdirSync(wsdlDir);
    // WSDL inside node_modules — must be skipped
    fs.copyFileSync(PATIENT_WSDL_SRC, path.join(nodeDir, 'hidden.wsdl'));
    // WSDL in real path — must be found
    fs.copyFileSync(PATIENT_WSDL_SRC, path.join(wsdlDir, 'PatientService.wsdl'));

    const results = findWsdlFiles(dir);
    assert.equal(results.length, 1, 'only the non-node_modules WSDL should be found');
    assert.ok(!results[0].includes('node_modules'), 'result must not be inside node_modules');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── runSoapTier0 ───────────────────────────────────────────────────────────

test('runSoapTier0: returns written:false when no WSDLs present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-tier0-'));
  try {
    const result = await runSoapTier0({ projectPath: dir, outputDir: path.join(dir, 'out') });
    assert.equal(result.written,      false, 'written should be false');
    assert.equal(result.writtenCount, 0,     'writtenCount should be 0');
    assert.deepEqual(result.filenames, [],   'filenames should be empty');
    assert.deepEqual(result.services,  [],   'services should be empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSoapTier0: emits SoapUI XML + Groovy files from PatientService WSDL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-tier0-'));
  try {
    const wsdlDir = path.join(dir, 'wsdl');
    fs.mkdirSync(wsdlDir);
    fs.copyFileSync(PATIENT_WSDL_SRC, path.join(wsdlDir, 'PatientService.wsdl'));

    const outDir = path.join(dir, 'out');
    const result = await runSoapTier0({ projectPath: dir, outputDir: outDir });

    assert.ok(result.written,      'written should be true');
    assert.ok(result.writtenCount > 0, 'writtenCount should be > 0');
    assert.ok(result.services.includes('PatientService'), 'PatientService should be listed');
    assert.equal(result.operations, 5, 'should report 5 operations');

    // Project XML should exist on disk
    const xmlFile = path.join(outDir, 'PatientService', 'PatientService-soapui-project.xml');
    assert.ok(fs.existsSync(xmlFile), `SoapUI project XML should exist at ${xmlFile}`);

    const xml = fs.readFileSync(xmlFile, 'utf-8');
    const testCaseCount = (xml.match(/<con:testCase\b/g) || []).length;
    assert.ok(
      testCaseCount >= 12,
      `SoapUI project should have ≥12 testCase elements, got ${testCaseCount}`
    );
    assert.ok(xml.includes('SOAP Fault Assertion'), 'at least one SOAP Fault assertion must be present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSoapTier0: does not throw when a WSDL file is unreadable/malformed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-tier0-'));
  try {
    fs.writeFileSync(path.join(dir, 'broken.wsdl'), '<not valid wsdl', 'utf-8');

    const outDir = path.join(dir, 'out');
    // Should not throw — malformed WSDLs are silently skipped
    const result = await runSoapTier0({ projectPath: dir, outputDir: outDir });
    assert.equal(result.written, false, 'malformed WSDL should produce written:false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
