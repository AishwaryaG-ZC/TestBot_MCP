'use strict';

/**
 * Generates the Groovy preamble script embedded as a SoapUI setup test step.
 * Validates endpoint reachability and defines shared helpers used across all
 * operation scripts in the same test suite.
 *
 * @param {string} serviceName
 * @param {string} endpoint
 * @returns {string}
 */
function buildPreambleGroovy(serviceName, endpoint) {
  return `// Healix SOAP Tier-0 — ${serviceName} — Suite Setup
import groovy.xml.XmlSlurper

def endpoint = testSuite.getPropertyValue("endpoint") ?: "${endpoint}"
context.setProperty("soapEndpoint", endpoint)
log.info "[Healix] ${serviceName} SOAP tests targeting: \${endpoint}"

// WSDL reachability check
try {
  def wsdlUrl = new URL("\${endpoint}?wsdl")
  def conn = wsdlUrl.openConnection()
  conn.setConnectTimeout(5000)
  conn.setReadTimeout(5000)
  def code = conn.responseCode
  assert code == 200 : "WSDL endpoint not reachable (HTTP \${code})"
  log.info "[Healix] WSDL reachable at \${endpoint}?wsdl"
} catch (e) {
  log.warn "[Healix] Could not reach WSDL endpoint: \${e.message}"
}

// Shared helper: assert response does not contain a SOAP Fault
def assertNoFault = { xml ->
  def parsed = new XmlSlurper().parseText(xml)
  def fault = parsed.'**'.find { it.name() == 'Fault' }
  assert fault == null : "Unexpected SOAP Fault in response: \${xml}"
}
context.setProperty("assertNoFault", assertNoFault)

log.info "[Healix] ${serviceName} suite setup complete"
`;
}

/**
 * Generates the Groovy teardown script — logs summary and clears shared state.
 *
 * @param {string} serviceName
 * @returns {string}
 */
function buildTeardownGroovy(serviceName) {
  return `// Healix SOAP Tier-0 — ${serviceName} — Suite Teardown
log.info "[Healix] ${serviceName} SOAP test suite complete"

// Clear shared context properties
context.setProperty("soapEndpoint", null)
context.setProperty("assertNoFault", null)

def pass  = testSuite.passedTestCaseCount
def fail  = testSuite.failedTestCaseCount
def total = pass + fail
log.info "[Healix] Results: \${pass}/\${total} passed, \${fail} failed"
`;
}

/**
 * Generates a per-operation Groovy script for the happy-path test case.
 * Includes a SOAP envelope builder, response parser, and assertNoFault call.
 *
 * @param {{ name: string, inputParts: Array<{name:string, type:string}>, outputParts: Array<{name:string, type:string}> }} op
 * @param {string} namespace
 * @returns {string}
 */
function buildOperationGroovy(op, namespace) {
  const ns    = namespace || 'http://pulseboard.soap/patient';
  const parts = op.inputParts || [];

  const paramLines = parts.map(p => {
    const sampleVal = sampleValue(p.type);
    return `  def ${p.name} = ${JSON.stringify(sampleVal)}`;
  }).join('\n');

  const bodyChildren = parts.map(p =>
    `      <tns:${p.name}>\${${p.name}}</tns:${p.name}>`
  ).join('\n');

  return `// Healix SOAP Tier-0 — ${op.name} — Happy Path
import groovy.xml.XmlSlurper

def endpoint     = context.getProperty("soapEndpoint") ?: testSuite.getPropertyValue("endpoint")
def assertNoFault = context.getProperty("assertNoFault")

// Sample input values
${paramLines}

// Build SOAP envelope
def soapEnvelope = """<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:${op.name}Request>
${bodyChildren}
    </tns:${op.name}Request>
  </soapenv:Body>
</soapenv:Envelope>"""

// Send request
def conn = new URL(endpoint).openConnection()
conn.setRequestMethod("POST")
conn.setDoOutput(true)
conn.setRequestProperty("Content-Type", "text/xml; charset=UTF-8")
conn.setRequestProperty("SOAPAction", "${ns}/${op.name}")
conn.outputStream.withWriter("UTF-8") { it << soapEnvelope }

def responseXml = conn.inputStream.text
log.info "[Healix] ${op.name} response: \${responseXml}"

// Assert no fault
if (assertNoFault) assertNoFault(responseXml)

// Assert expected response element present
def parsed = new XmlSlurper().parseText(responseXml)
def result = parsed.'**'.find { it.name().contains("${op.name}Response") || it.name().contains("${op.name}Result") }
assert result != null : "${op.name} response element not found in: \${responseXml}"

log.info "[Healix] ${op.name} happy-path assertion passed"
`;
}

// ─── internal ───────────────────────────────────────────────────────────────

function sampleValue(xsdType) {
  const t = (xsdType || '').toLowerCase().replace(/.*:/, '');
  if (t === 'boolean') return 'true';
  if (t === 'int' || t === 'integer' || t === 'long') return '1';
  if (t === 'date') return '1990-01-01';
  return 'test-value';
}

module.exports = { buildPreambleGroovy, buildTeardownGroovy, buildOperationGroovy };
