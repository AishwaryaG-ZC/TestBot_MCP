'use strict';

const { test } = require('node:test');
const assert   = require('assert/strict');

const { buildPreambleGroovy, buildTeardownGroovy, buildOperationGroovy } = require('../src/soap/groovy-templates');
const { buildFaultAssertionXml, buildSoapEnvelopeForFault, buildXPathAssertion, buildNotFaultAssertionXml } = require('../src/soap/soap-fault-templates');

const SAMPLE_OP = {
  name: 'GetPatient',
  soapAction: 'http://pulseboard.soap/patient/GetPatient',
  inputParts:  [{ name: 'id', type: 'xsd:string' }],
  outputParts: [{ name: 'PatientId', type: 'xsd:string' }, { name: 'Name', type: 'xsd:string' }],
  faults: [{ name: 'PatientNotFound', message: 'PatientNotFoundFault' }],
};

test('buildPreambleGroovy: contains endpoint property reference and XmlSlurper import', () => {
  const groovy = buildPreambleGroovy('PatientService', 'http://localhost:4802/patient');

  assert.ok(groovy.includes('XmlSlurper'),     'must import XmlSlurper');
  assert.ok(groovy.includes('endpoint'),        'must reference endpoint property');
  assert.ok(groovy.includes('PatientService'),  'must include service name');
  assert.ok(groovy.includes('4802'),            'must include the endpoint URL');
  assert.ok(groovy.includes('assertNoFault'),   'must define assertNoFault helper');
});

test('buildTeardownGroovy: contains cleanup log line and summary', () => {
  const groovy = buildTeardownGroovy('PatientService');

  assert.ok(groovy.includes('log.info'),       'must include log.info call');
  assert.ok(groovy.includes('PatientService'), 'must include service name');
  assert.ok(groovy.includes('setProperty') || groovy.includes('complete'), 'must reference cleanup or completion');
});

test('buildOperationGroovy: contains assertNoFault call and SOAPAction', () => {
  const groovy = buildOperationGroovy(SAMPLE_OP, 'http://pulseboard.soap/patient');

  assert.ok(groovy.includes('assertNoFault'),   'must call assertNoFault');
  assert.ok(groovy.includes('GetPatient'),       'must reference operation name');
  assert.ok(groovy.includes('SOAPAction'),       'must set SOAPAction header');
  assert.ok(groovy.includes('soapenv:Envelope'), 'must build SOAP envelope');
});

test('buildSoapEnvelopeForFault: wraps bad input fields in correct SOAP envelope structure', () => {
  const envelope = buildSoapEnvelopeForFault('GetPatient', 'http://pulseboard.soap/patient', { id: 'INVALID' });

  assert.ok(envelope.includes('soapenv:Envelope'), 'must have Envelope element');
  assert.ok(envelope.includes('soapenv:Body'),     'must have Body element');
  assert.ok(envelope.includes('GetPatientRequest'), 'must have operation request element');
  assert.ok(envelope.includes('INVALID'),           'must include the bad input value');
  assert.ok(envelope.includes('<tns:id>'),          'must wrap field in tns namespace element');
});

test('buildFaultAssertionXml: generates SOAP Fault Assertion XML with faultcode check', () => {
  const xml = buildFaultAssertionXml('PatientNotFound', 'PatientNotFound');

  assert.ok(xml.includes('SOAP Fault Assertion'),     'must be a SOAP Fault Assertion');
  assert.ok(xml.includes('PatientNotFound'),          'must reference fault name');
  assert.ok(xml.includes('XPath Match'),              'must include XPath Match assertion for faultcode');
  assert.ok(xml.includes('<path>//faultcode</path>'), 'must check the faultcode element');
});

test('buildNotFaultAssertionXml: generates Not SOAP Fault Assertion XML', () => {
  const xml = buildNotFaultAssertionXml();

  assert.ok(xml.includes('Not SOAP Fault Assertion'), 'must be Not SOAP Fault Assertion type');
});

test('buildXPathAssertion: generates well-formed XPath Match assertion', () => {
  const xml = buildXPathAssertion("//*[local-name()='PatientId']", 'P001', 'Has PatientId');

  assert.ok(xml.includes('XPath Match'),   'must be XPath Match type');
  assert.ok(xml.includes('PatientId'),     'must include the expression');
  assert.ok(xml.includes('Has PatientId'), 'must include the label');
});
