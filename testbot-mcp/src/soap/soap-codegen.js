'use strict';

const fs   = require('fs');
const path = require('path');

const { buildPreambleGroovy, buildTeardownGroovy, buildOperationGroovy } = require('./groovy-templates');
const {
  buildFaultAssertionXml,
  buildNotFaultAssertionXml,
  buildXPathAssertion,
  buildHttpStatusAssertion,
  buildSoapEnvelopeForFault,
} = require('./soap-fault-templates');

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a SoapUI 5.x XML project string from a parsed WSDL object.
 *
 * @param {ReturnType<import('./wsdl-parser').parseWsdl>} parsedWsdl
 * @returns {string} SoapUI project XML
 */
function generateSoapUiProject(parsedWsdl) {
  const { serviceName, targetNamespace, endpoint, operations } = parsedWsdl;
  const testCases = buildAllTestCases(operations, targetNamespace, endpoint);
  const preamble  = buildGroovyTestStep('Suite_Setup',   buildPreambleGroovy(serviceName, endpoint));
  const teardown  = buildGroovyTestStep('Suite_Teardown', buildTeardownGroovy(serviceName));

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:soapui-project
    xmlns:con="http://eviware.com/soapui/config"
    name="${xmlEscape(serviceName)}"
    resourceRoot=""
    soapui-version="5.7.2">

  <con:settings/>

  <con:testSuite name="${xmlEscape(serviceName)} Tests" runType="SEQUENTIAL">
    <con:settings/>
    <con:properties/>

    <!-- Suite-level setup/teardown as the first/last test cases -->
    <con:testCase name="_Suite_Setup" failOnError="true" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="groovy" name="Suite_Setup">
        <con:settings/>
        <con:config>
          <script>${xmlEscape(buildPreambleGroovy(serviceName, endpoint))}</script>
        </con:config>
      </con:testStep>
    </con:testCase>

${testCases}
    <con:testCase name="_Suite_Teardown" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="groovy" name="Suite_Teardown">
        <con:settings/>
        <con:config>
          <script>${xmlEscape(buildTeardownGroovy(serviceName))}</script>
        </con:config>
      </con:testStep>
    </con:testCase>

    <con:properties>
      <con:property>
        <con:name>endpoint</con:name>
        <con:value>${xmlEscape(endpoint)}</con:value>
      </con:property>
    </con:properties>
  </con:testSuite>

</con:soapui-project>`;
}

/**
 * Generate Groovy scaffold files — one preamble, one teardown, one per operation.
 *
 * @param {ReturnType<import('./wsdl-parser').parseWsdl>} parsedWsdl
 * @returns {Object.<string, string>} filename -> content map
 */
function generateGroovyScaffolds(parsedWsdl) {
  const { serviceName, targetNamespace, endpoint, operations } = parsedWsdl;
  const files = {};

  files['setup.groovy']    = buildPreambleGroovy(serviceName, endpoint);
  files['teardown.groovy'] = buildTeardownGroovy(serviceName);

  for (const op of operations) {
    const fname = `${op.name.replace(/\s+/g, '_')}.groovy`;
    files[fname] = buildOperationGroovy(op, targetNamespace);
  }

  return files;
}

/**
 * Write SoapUI project XML + Groovy scaffolds to outputDir.
 *
 * @param {ReturnType<import('./wsdl-parser').parseWsdl>} parsedWsdl
 * @param {string} outputDir
 * @returns {{ projectFile: string, groovyDir: string, filenames: string[], writtenCount: number }}
 */
function writeSoapTestFiles(parsedWsdl, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const groovyDir = path.join(outputDir, 'groovy');
  fs.mkdirSync(groovyDir, { recursive: true });

  const projectXml      = generateSoapUiProject(parsedWsdl);
  const projectFilename = `${sanitizeFilename(parsedWsdl.serviceName)}-soapui-project.xml`;
  const projectFile     = path.join(outputDir, projectFilename);
  fs.writeFileSync(projectFile, projectXml, 'utf-8');

  const scaffolds = generateGroovyScaffolds(parsedWsdl);
  const filenames = [projectFilename];
  for (const [fname, content] of Object.entries(scaffolds)) {
    fs.writeFileSync(path.join(groovyDir, fname), content, 'utf-8');
    filenames.push(`groovy/${fname}`);
  }

  return {
    projectFile,
    groovyDir,
    filenames,
    writtenCount: filenames.length,
  };
}

// ─── Test Case Builders ──────────────────────────────────────────────────────

/**
 * Builds all test cases: 1 happy path + N fault cases per operation,
 * plus extra boundary/schema/filter cases. Targets 14 total.
 */
function buildAllTestCases(operations, ns, endpoint) {
  const cases = [];

  for (const op of operations) {
    // Happy path
    cases.push(buildHappyPathTestCase(op, ns, endpoint));

    // Fault cases
    for (const fault of op.faults) {
      cases.push(buildFaultTestCase(op, fault, ns, endpoint));
    }
  }

  // Extra cases to reach 12-15 total
  const getPatient = operations.find(o => o.name === 'GetPatient');
  const createPatient = operations.find(o => o.name === 'CreatePatient');
  const listPatients = operations.find(o => o.name === 'ListPatients');

  if (getPatient) {
    cases.push(buildMalformedEnvelopeTestCase(getPatient, ns, endpoint));
  }
  if (createPatient) {
    cases.push(buildBoundaryTestCase(createPatient, ns, endpoint));
  }
  if (listPatients) {
    cases.push(buildFilterTestCase(listPatients, ns, endpoint));
  }

  // Schema validation test case (generic)
  if (getPatient) {
    cases.push(buildSchemaValidationTestCase(getPatient, ns, endpoint));
  }

  return cases.map(c => c.xml).join('\n');
}

function buildHappyPathTestCase(op, ns, endpoint) {
  const envelope = buildHappyEnvelope(op, ns);
  const responseTags = op.outputParts.map(p =>
    buildXPathAssertion(`//*[local-name()='${p.name}']`, '', `Response has <${p.name}>`)
  ).join('\n');

  return {
    xml: `    <con:testCase name="${xmlEscape(op.name)} - Happy Path" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="request" name="${xmlEscape(op.name)}_Happy">
        <con:settings/>
        <con:config>
          <con:service>${xmlEscape(op.name)}</con:service>
          <con:endpoint>${xmlEscape(endpoint)}</con:endpoint>
          <con:request>${xmlEscape(envelope)}</con:request>
          <con:soapAction>${xmlEscape(op.soapAction)}</con:soapAction>
          <con:assertions>
${buildHttpStatusAssertion(200)}
${buildNotFaultAssertionXml()}
          </con:assertions>
        </con:config>
      </con:testStep>
    </con:testCase>`,
  };
}

function buildFaultTestCase(op, fault, ns, endpoint) {
  const badInputMap = faultTrigger(op.name, fault.name);
  const envelope    = buildSoapEnvelopeForFault(op.name, ns, badInputMap);

  return {
    xml: `    <con:testCase name="${xmlEscape(op.name)} - ${xmlEscape(fault.name)} Fault" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="request" name="${xmlEscape(op.name)}_${xmlEscape(fault.name)}_Fault">
        <con:settings/>
        <con:config>
          <con:service>${xmlEscape(op.name)}</con:service>
          <con:endpoint>${xmlEscape(endpoint)}</con:endpoint>
          <con:request>${xmlEscape(envelope)}</con:request>
          <con:soapAction>${xmlEscape(op.soapAction)}</con:soapAction>
          <con:assertions>
${buildFaultAssertionXml(fault.name, fault.name)}
          </con:assertions>
        </con:config>
      </con:testStep>
    </con:testCase>`,
  };
}

function buildMalformedEnvelopeTestCase(op, ns, endpoint) {
  const malformed = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <INVALID_ELEMENT/>
  </soapenv:Body>
</soapenv:Envelope>`;

  return {
    xml: `    <con:testCase name="${xmlEscape(op.name)} - Malformed Request Client Fault" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="request" name="${xmlEscape(op.name)}_Malformed">
        <con:settings/>
        <con:config>
          <con:service>${xmlEscape(op.name)}</con:service>
          <con:endpoint>${xmlEscape(endpoint)}</con:endpoint>
          <con:request>${xmlEscape(malformed)}</con:request>
          <con:soapAction>${xmlEscape(op.soapAction)}</con:soapAction>
          <con:assertions>
${buildFaultAssertionXml('Client', 'Client')}
          </con:assertions>
        </con:config>
      </con:testStep>
    </con:testCase>`,
  };
}

function buildBoundaryTestCase(op, ns, endpoint) {
  const longName = 'A'.repeat(255);
  const envelope = buildSoapEnvelopeForFault(op.name, ns, { Name: longName, DateOfBirth: '1990-01-01', MRN: 'BOUNDARY001' });

  return {
    xml: `    <con:testCase name="${xmlEscape(op.name)} - Boundary Name 255 chars" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="request" name="${xmlEscape(op.name)}_Boundary">
        <con:settings/>
        <con:config>
          <con:service>${xmlEscape(op.name)}</con:service>
          <con:endpoint>${xmlEscape(endpoint)}</con:endpoint>
          <con:request>${xmlEscape(envelope)}</con:request>
          <con:soapAction>${xmlEscape(op.soapAction)}</con:soapAction>
          <con:assertions>
${buildHttpStatusAssertion(200)}
${buildNotFaultAssertionXml()}
${buildXPathAssertion("//*[local-name()='PatientId']", '', 'Response has PatientId')}
          </con:assertions>
        </con:config>
      </con:testStep>
    </con:testCase>`,
  };
}

function buildFilterTestCase(op, ns, endpoint) {
  const envelope = buildSoapEnvelopeForFault(op.name, ns, { Status: 'active' });

  return {
    xml: `    <con:testCase name="${xmlEscape(op.name)} - Filter by Status" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="request" name="${xmlEscape(op.name)}_Filter">
        <con:settings/>
        <con:config>
          <con:service>${xmlEscape(op.name)}</con:service>
          <con:endpoint>${xmlEscape(endpoint)}</con:endpoint>
          <con:request>${xmlEscape(envelope)}</con:request>
          <con:soapAction>${xmlEscape(op.soapAction)}</con:soapAction>
          <con:assertions>
${buildHttpStatusAssertion(200)}
${buildNotFaultAssertionXml()}
          </con:assertions>
        </con:config>
      </con:testStep>
    </con:testCase>`,
  };
}

function buildSchemaValidationTestCase(op, ns, endpoint) {
  const envelope = buildHappyEnvelope(op, ns);

  return {
    xml: `    <con:testCase name="${xmlEscape(op.name)} - Schema Validation" failOnError="false" runMode="SINGLE_INSTANCE">
      <con:settings/>
      <con:testStep type="request" name="${xmlEscape(op.name)}_Schema">
        <con:settings/>
        <con:config>
          <con:service>${xmlEscape(op.name)}</con:service>
          <con:endpoint>${xmlEscape(endpoint)}</con:endpoint>
          <con:request>${xmlEscape(envelope)}</con:request>
          <con:soapAction>${xmlEscape(op.soapAction)}</con:soapAction>
          <con:assertions>
${buildHttpStatusAssertion(200)}
${buildNotFaultAssertionXml()}
        <con:assertion type="Schema Compliance" name="Response Schema Compliance">
          <con:configuration/>
        </con:assertion>
          </con:assertions>
        </con:config>
      </con:testStep>
    </con:testCase>`,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildGroovyTestStep(name, script) {
  return `      <con:testStep type="groovy" name="${xmlEscape(name)}">
        <con:settings/>
        <con:config>
          <script>${xmlEscape(script)}</script>
        </con:config>
      </con:testStep>`;
}

function buildHappyEnvelope(op, ns) {
  const fields = (op.inputParts || []).map(p => {
    const v = happyValue(p.name, p.type);
    return `      <tns:${p.name}>${xmlEscape(String(v))}</tns:${p.name}>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:${op.name}Request>
${fields}
    </tns:${op.name}Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Returns the bad input map that will trigger a specific fault.
 */
function faultTrigger(operationName, faultName) {
  const triggers = {
    GetPatient:    { PatientNotFound: { id: 'INVALID' } },
    CreatePatient: { DuplicateMRN: { Name: 'Test', DateOfBirth: '1990-01-01', MRN: 'DUP001' }, ValidationError: { Name: '', DateOfBirth: '1990-01-01', MRN: 'NEWMRN' } },
    UpdatePatient: { PatientNotFound: { id: 'INVALID', Name: 'Updated' } },
    DeletePatient: { PatientNotFound: { id: 'INVALID' } },
  };
  return (triggers[operationName] || {})[faultName] || { id: 'INVALID' };
}

function happyValue(fieldName, xsdType) {
  const field = (fieldName || '').toLowerCase();
  if (field === 'id') return 'P001';
  if (field === 'mrn') return `MRN-${Date.now() % 10000}`;
  if (field === 'dateofbirth' || field === 'dob') return '1990-01-01';
  if (field === 'name') return 'Test Patient';
  if (field === 'status') return 'active';
  const t = (xsdType || '').toLowerCase().replace(/.*:/, '');
  if (t === 'boolean') return 'true';
  if (t === 'int' || t === 'integer') return '1';
  return 'test-value';
}

function sanitizeFilename(name) {
  return (name || 'Service').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

module.exports = { generateSoapUiProject, generateGroovyScaffolds, writeSoapTestFiles };
