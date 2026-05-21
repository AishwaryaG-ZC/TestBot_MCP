'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'], limit: '1mb' }));
app.use(express.raw({ type: '*/*', limit: '1mb' }));

const WSDL_PATH = path.join(__dirname, '../wsdl/PatientService.wsdl');
const NS = 'http://pulseboard.soap/patient';

// In-memory store
const patients = [
  { id: 'P001', name: 'Alice Smith',   dob: '1985-03-12', mrn: 'MRN001', status: 'active' },
  { id: 'P002', name: 'Bob Johnson',   dob: '1972-07-24', mrn: 'MRN002', status: 'active' },
  { id: 'P003', name: 'Carol White',   dob: '1990-11-05', mrn: 'MRN003', status: 'discharged' },
];
let nextId = 4;

function soapEnvelope(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${NS}">
  <soapenv:Header/>
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`;
}

function soapFault(code, message, detail) {
  return soapEnvelope(`<soapenv:Fault>
      <faultcode>${code}</faultcode>
      <faultstring>${message}</faultstring>
      <detail>${detail}</detail>
    </soapenv:Fault>`);
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>(.*?)</(?:[^:>]+:)?${tag}>`, 's'));
  return m ? m[1].trim() : null;
}

// WSDL endpoint
app.get('/', (req, res) => {
  if ('wsdl' in req.query || req.query.wsdl === '') {
    res.set('Content-Type', 'text/xml');
    res.send(fs.readFileSync(WSDL_PATH));
    return;
  }
  res.status(200).send('PatientService SOAP endpoint. Use POST with a SOAP envelope or GET /?wsdl for the WSDL.');
});

app.get('/patient', (req, res) => {
  if ('wsdl' in req.query || req.query.wsdl === '') {
    res.set('Content-Type', 'text/xml');
    res.send(fs.readFileSync(WSDL_PATH));
    return;
  }
  res.status(200).send('PatientService SOAP endpoint.');
});

// SOAP action dispatcher
app.post(['/patient', '/'], (req, res) => {
  res.set('Content-Type', 'text/xml');

  const body = typeof req.body === 'string' ? req.body : req.body?.toString?.() ?? '';

  // Detect operation from SOAPAction header or body element
  const soapAction = (req.headers['soapaction'] || '').replace(/"/g, '');
  let operation = soapAction.split('/').pop();

  if (!operation) {
    if (body.includes('GetPatientRequest'))    operation = 'GetPatient';
    else if (body.includes('CreatePatientRequest'))  operation = 'CreatePatient';
    else if (body.includes('UpdatePatientRequest'))  operation = 'UpdatePatient';
    else if (body.includes('ListPatientsRequest'))   operation = 'ListPatients';
    else if (body.includes('DeletePatientRequest'))  operation = 'DeletePatient';
  }

  switch (operation) {
    case 'GetPatient': return handleGetPatient(body, res);
    case 'CreatePatient': return handleCreatePatient(body, res);
    case 'UpdatePatient': return handleUpdatePatient(body, res);
    case 'ListPatients': return handleListPatients(body, res);
    case 'DeletePatient': return handleDeletePatient(body, res);
    default:
      return res.status(400).send(soapFault('Client', 'Unknown operation', `<message>Unrecognised operation: ${operation}</message>`));
  }
});

function handleGetPatient(body, res) {
  const id = extractTag(body, 'id');

  if (!id || id === 'INVALID' || id === '') {
    return res.status(500).send(soapFault(
      'PatientNotFound',
      'Patient not found',
      `<tns:PatientNotFoundFault><message>No patient with id '${id}'</message><patientId>${id}</patientId></tns:PatientNotFoundFault>`
    ));
  }

  const p = patients.find(x => x.id === id);
  if (!p) {
    return res.status(500).send(soapFault(
      'PatientNotFound',
      'Patient not found',
      `<tns:PatientNotFoundFault><message>No patient with id '${id}'</message><patientId>${id}</patientId></tns:PatientNotFoundFault>`
    ));
  }

  res.send(soapEnvelope(`<tns:GetPatientResponse>
      <tns:PatientId>${p.id}</tns:PatientId>
      <tns:Name>${p.name}</tns:Name>
      <tns:DateOfBirth>${p.dob}</tns:DateOfBirth>
      <tns:MRN>${p.mrn}</tns:MRN>
      <tns:Status>${p.status}</tns:Status>
    </tns:GetPatientResponse>`));
}

function handleCreatePatient(body, res) {
  const name = extractTag(body, 'Name');
  const dob  = extractTag(body, 'DateOfBirth');
  const mrn  = extractTag(body, 'MRN');

  if (!name || name.trim() === '') {
    return res.status(500).send(soapFault(
      'ValidationError',
      'Validation failed',
      `<tns:ValidationErrorFault><message>Name is required</message><field>Name</field></tns:ValidationErrorFault>`
    ));
  }

  if (mrn === 'DUP001' || patients.find(p => p.mrn === mrn)) {
    return res.status(500).send(soapFault(
      'DuplicateMRN',
      'Duplicate MRN',
      `<tns:DuplicateMRNFault><message>MRN '${mrn}' already exists</message><mrn>${mrn}</mrn></tns:DuplicateMRNFault>`
    ));
  }

  const id = `P${String(nextId++).padStart(3, '0')}`;
  patients.push({ id, name, dob: dob || '', mrn, status: 'active' });
  res.send(soapEnvelope(`<tns:CreatePatientResponse>
      <tns:PatientId>${id}</tns:PatientId>
    </tns:CreatePatientResponse>`));
}

function handleUpdatePatient(body, res) {
  const id   = extractTag(body, 'id');
  const name = extractTag(body, 'Name');
  const dob  = extractTag(body, 'DateOfBirth');

  const p = patients.find(x => x.id === id);
  if (!p) {
    return res.status(500).send(soapFault(
      'PatientNotFound',
      'Patient not found',
      `<tns:PatientNotFoundFault><message>No patient with id '${id}'</message><patientId>${id}</patientId></tns:PatientNotFoundFault>`
    ));
  }

  if (name) p.name = name;
  if (dob)  p.dob  = dob;
  res.send(soapEnvelope(`<tns:UpdatePatientResponse>
      <tns:PatientId>${p.id}</tns:PatientId>
      <tns:Updated>true</tns:Updated>
    </tns:UpdatePatientResponse>`));
}

function handleListPatients(body, res) {
  const status = extractTag(body, 'Status');
  const list   = status ? patients.filter(p => p.status === status) : patients;
  const items  = list.map(p => `<tns:Patients>
        <tns:PatientId>${p.id}</tns:PatientId>
        <tns:Name>${p.name}</tns:Name>
        <tns:Status>${p.status}</tns:Status>
      </tns:Patients>`).join('\n      ');
  res.send(soapEnvelope(`<tns:ListPatientsResponse>
      ${items}
    </tns:ListPatientsResponse>`));
}

function handleDeletePatient(body, res) {
  const id  = extractTag(body, 'id');
  const idx = patients.findIndex(x => x.id === id);
  if (idx === -1) {
    return res.status(500).send(soapFault(
      'PatientNotFound',
      'Patient not found',
      `<tns:PatientNotFoundFault><message>No patient with id '${id}'</message><patientId>${id}</patientId></tns:PatientNotFoundFault>`
    ));
  }
  patients.splice(idx, 1);
  res.send(soapEnvelope(`<tns:DeletePatientResponse>
      <tns:Deleted>true</tns:Deleted>
    </tns:DeletePatientResponse>`));
}

const PORT = process.env.PORT || 4802;
app.listen(PORT, () => {
  console.log(`PatientService SOAP server running on http://localhost:${PORT}`);
  console.log(`WSDL available at http://localhost:${PORT}/?wsdl`);
});

module.exports = app;
