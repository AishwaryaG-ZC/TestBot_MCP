'use strict';

const { test } = require('node:test');
const assert   = require('assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const { generateSoapUiProject, generateGroovyScaffolds, writeSoapTestFiles } = require('../src/soap/soap-codegen');
const { parseWsdlFile } = require('../src/soap/wsdl-parser');

const PATIENT_WSDL = path.join(__dirname, '../../compat-fixtures/pulseboard-soap/wsdl/PatientService.wsdl');

function getParsedPatientWsdl() {
  return parseWsdlFile(PATIENT_WSDL);
}

test('generateSoapUiProject: returns XML containing <con:soapui-project>', () => {
  const parsed = getParsedPatientWsdl();
  const xml = generateSoapUiProject(parsed);

  assert.ok(typeof xml === 'string', 'should return a string');
  assert.ok(xml.includes('<con:soapui-project'), 'must contain soapui-project element');
  assert.ok(xml.includes('xmlns:con="http://eviware.com/soapui/config"'), 'must have SoapUI config namespace');
  assert.ok(xml.includes('PatientService'), 'must reference the service name');
});

test('generateSoapUiProject: generated XML contains at least 12 <con:testCase> elements', () => {
  const parsed = getParsedPatientWsdl();
  const xml = generateSoapUiProject(parsed);

  const matches = xml.match(/<con:testCase\b/g) || [];
  assert.ok(
    matches.length >= 12,
    `Expected ≥12 testCase elements, got ${matches.length}`
  );
});

test('generateSoapUiProject: contains at least one SOAP Fault assertion', () => {
  const parsed = getParsedPatientWsdl();
  const xml = generateSoapUiProject(parsed);

  assert.ok(
    xml.includes('SOAP Fault Assertion') || xml.includes('type="SOAP Fault'),
    'must contain at least one SOAP Fault assertion'
  );
});

test('generateSoapUiProject: each operation has a happy-path test case', () => {
  const parsed = getParsedPatientWsdl();
  const xml = generateSoapUiProject(parsed);

  for (const op of parsed.operations) {
    assert.ok(
      xml.includes(`${op.name} - Happy Path`),
      `Expected happy-path test case for ${op.name}`
    );
  }
});

test('writeSoapTestFiles: creates project XML and groovy/ directory on disk', () => {
  const parsed = getParsedPatientWsdl();
  const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-soap-'));
  try {
    const result = writeSoapTestFiles(parsed, dir);

    assert.ok(result.writtenCount > 0, 'writtenCount should be > 0');
    assert.ok(result.filenames.length > 0, 'filenames should not be empty');

    // Project XML file exists
    const xmlFile = path.join(dir, result.filenames[0]);
    assert.ok(fs.existsSync(xmlFile), `Project XML file should exist at ${xmlFile}`);

    // Groovy directory exists
    const groovyDir = path.join(dir, 'groovy');
    assert.ok(fs.existsSync(groovyDir), 'groovy/ directory should exist');

    // At least setup.groovy and teardown.groovy present
    assert.ok(fs.existsSync(path.join(groovyDir, 'setup.groovy')),    'setup.groovy should exist');
    assert.ok(fs.existsSync(path.join(groovyDir, 'teardown.groovy')), 'teardown.groovy should exist');

    // One Groovy file per operation
    for (const op of parsed.operations) {
      const gFile = path.join(groovyDir, `${op.name}.groovy`);
      assert.ok(fs.existsSync(gFile), `${op.name}.groovy should exist`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
