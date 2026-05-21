'use strict';

const { test } = require('node:test');
const assert   = require('assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const { parseWsdl, parseWsdlFile } = require('../src/soap/wsdl-parser');

// Minimal valid WSDL for unit tests
const MINIMAL_WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<definitions
  xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:tns="http://example.com/hello"
  targetNamespace="http://example.com/hello"
  name="HelloService">
  <types>
    <xsd:schema targetNamespace="http://example.com/hello">
      <xsd:element name="SayHelloRequest">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="name" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="SayHelloResponse">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="greeting" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="NotFoundFault">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="message" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>
  <message name="SayHelloInput">
    <part name="parameters" element="tns:SayHelloRequest"/>
  </message>
  <message name="SayHelloOutput">
    <part name="parameters" element="tns:SayHelloResponse"/>
  </message>
  <message name="NotFoundFault">
    <part name="fault" element="tns:NotFoundFault"/>
  </message>
  <portType name="HelloPortType">
    <operation name="SayHello">
      <input  message="tns:SayHelloInput"/>
      <output message="tns:SayHelloOutput"/>
      <fault  name="NotFound" message="tns:NotFoundFault"/>
    </operation>
  </portType>
  <binding name="HelloBinding" type="tns:HelloPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="SayHello">
      <soap:operation soapAction="http://example.com/hello/SayHello"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
      <fault name="NotFound"><soap:fault name="NotFound" use="literal"/></fault>
    </operation>
  </binding>
  <service name="HelloService">
    <port name="HelloPort" binding="tns:HelloBinding">
      <soap:address location="http://localhost:9999/hello"/>
    </port>
  </service>
</definitions>`;

// Full PatientService WSDL path
const PATIENT_WSDL = path.join(__dirname, '../../compat-fixtures/pulseboard-soap/wsdl/PatientService.wsdl');

test('parseWsdl: extracts service name, namespace, and endpoint from minimal WSDL', () => {
  const result = parseWsdl(MINIMAL_WSDL);

  assert.equal(result.serviceName,     'HelloService',           'serviceName');
  assert.equal(result.targetNamespace, 'http://example.com/hello', 'targetNamespace');
  assert.equal(result.endpoint,        'http://localhost:9999/hello', 'endpoint');
});

test('parseWsdlFile: extracts all 5 operations from PatientService WSDL', () => {
  const result = parseWsdlFile(PATIENT_WSDL);

  assert.equal(result.serviceName, 'PatientService', 'service name');
  assert.equal(result.operations.length, 5, 'should have 5 operations');

  const names = result.operations.map(o => o.name);
  assert.ok(names.includes('GetPatient'),    'GetPatient present');
  assert.ok(names.includes('CreatePatient'), 'CreatePatient present');
  assert.ok(names.includes('UpdatePatient'), 'UpdatePatient present');
  assert.ok(names.includes('ListPatients'),  'ListPatients present');
  assert.ok(names.includes('DeletePatient'), 'DeletePatient present');
});

test('parseWsdlFile: extracts fault definitions including PatientNotFound and DuplicateMRN', () => {
  const result = parseWsdlFile(PATIENT_WSDL);

  const getPatient = result.operations.find(o => o.name === 'GetPatient');
  assert.ok(getPatient, 'GetPatient operation exists');
  const faultNames = getPatient.faults.map(f => f.name);
  assert.ok(faultNames.includes('PatientNotFound'), `GetPatient should have PatientNotFound fault, got: ${faultNames}`);

  const createPatient = result.operations.find(o => o.name === 'CreatePatient');
  assert.ok(createPatient, 'CreatePatient operation exists');
  const createFaultNames = createPatient.faults.map(f => f.name);
  assert.ok(createFaultNames.includes('DuplicateMRN'),    `CreatePatient should have DuplicateMRN, got: ${createFaultNames}`);
  assert.ok(createFaultNames.includes('ValidationError'), `CreatePatient should have ValidationError, got: ${createFaultNames}`);
});

test('parseWsdl: resolves message parts to typed fields', () => {
  const result = parseWsdl(MINIMAL_WSDL);

  const op = result.operations.find(o => o.name === 'SayHello');
  assert.ok(op, 'SayHello operation found');
  assert.ok(op.inputParts.length > 0, 'SayHello should have input parts');
  const part = op.inputParts[0];
  assert.ok(part.name, 'part has a name');
  assert.ok(part.type, 'part has a type');
});

test('parseWsdl: returns empty operations array for malformed XML without throwing', () => {
  const result = parseWsdl('<this is not valid XML>>>');

  assert.ok(Array.isArray(result.operations), 'operations should be an array');
  assert.equal(result.operations.length, 0, 'no operations from malformed XML');
});
