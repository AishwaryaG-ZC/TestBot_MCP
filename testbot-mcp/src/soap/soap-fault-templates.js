'use strict';

/**
 * Builds a SoapUI <con:assertion> XML block that asserts the response IS a SOAP fault.
 *
 * @param {string} faultName   - display name, e.g. "PatientNotFound"
 * @param {string} [expectedCode] - optional faultcode to match via XPath
 * @returns {string} XML fragment
 */
function buildFaultAssertionXml(faultName, expectedCode) {
  const xpathBlock = expectedCode
    ? `\n        <con:assertion type="XPath Match" name="FaultCode matches ${faultName}">
          <con:configuration>
            <path>//faultcode</path>
            <content>${expectedCode}</content>
            <allowWildcards>false</allowWildcards>
            <ignoreNamespaceDifferences>true</ignoreNamespaceDifferences>
            <ignoreComments>true</ignoreComments>
          </con:configuration>
        </con:assertion>`
    : '';

  return `        <con:assertion type="SOAP Fault Assertion" name="Response is SOAP Fault (${faultName})">
          <con:configuration/>
        </con:assertion>${xpathBlock}`;
}

/**
 * Builds a SoapUI <con:assertion> that asserts the response is NOT a SOAP fault.
 *
 * @returns {string} XML fragment
 */
function buildNotFaultAssertionXml() {
  return `        <con:assertion type="Not SOAP Fault Assertion" name="Response is not SOAP Fault">
          <con:configuration/>
        </con:assertion>`;
}

/**
 * Builds a SoapUI XPath Match assertion block.
 *
 * @param {string} expression   - XPath expression
 * @param {string} expectedValue
 * @param {string} [label]
 * @returns {string} XML fragment
 */
function buildXPathAssertion(expression, expectedValue, label) {
  const name = label || `XPath: ${expression}`;
  return `        <con:assertion type="XPath Match" name="${xmlEscape(name)}">
          <con:configuration>
            <path>${xmlEscape(expression)}</path>
            <content>${xmlEscape(expectedValue)}</content>
            <allowWildcards>false</allowWildcards>
            <ignoreNamespaceDifferences>true</ignoreNamespaceDifferences>
            <ignoreComments>true</ignoreComments>
          </con:configuration>
        </con:assertion>`;
}

/**
 * Builds a SoapUI Valid HTTP Status Codes assertion block.
 *
 * @param {string|number} statusCode  e.g. 200
 * @returns {string} XML fragment
 */
function buildHttpStatusAssertion(statusCode) {
  return `        <con:assertion type="Valid HTTP Status Codes" name="HTTP ${statusCode}">
          <con:configuration>
            <codes>${statusCode}</codes>
          </con:configuration>
        </con:assertion>`;
}

/**
 * Builds the SOAP request envelope that will trigger a fault for the given operation.
 * The caller provides a map of field overrides; any field set to null/empty will be
 * omitted or sent blank to provoke server-side validation failures.
 *
 * @param {string} operationName
 * @param {string} namespace
 * @param {Object} badInput   - e.g. { id: 'INVALID' } or { Name: '' }
 * @returns {string} complete SOAP envelope string
 */
function buildSoapEnvelopeForFault(operationName, namespace, badInput) {
  const ns      = namespace || 'http://pulseboard.soap/patient';
  const reqElem = `${operationName}Request`;
  const fields  = Object.entries(badInput || {})
    .map(([k, v]) => `      <tns:${k}>${xmlEscape(String(v ?? ''))}</tns:${k}>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:${reqElem}>
${fields}
    </tns:${reqElem}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

module.exports = {
  buildFaultAssertionXml,
  buildNotFaultAssertionXml,
  buildXPathAssertion,
  buildHttpStatusAssertion,
  buildSoapEnvelopeForFault,
};
