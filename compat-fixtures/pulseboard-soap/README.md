# pulseboard-soap

Sample SOAP service fixture for Healix Prompt 03 — SOAP/WSDL/Groovy Codegen Module.

## Overview

Exposes a `PatientService` SOAP API on port 4802. The WSDL is served at `GET /?wsdl` and describes 5 operations across patient lifecycle management. Several operations intentionally trigger SOAP faults when given specific inputs so the Healix codegen's fault assertion templates can be exercised.

## Running

```bash
# From repo root
npm run start:pulseboard-soap

# Or directly
node compat-fixtures/pulseboard-soap/src/server.js
```

Server starts on `http://localhost:4802`. Override port with `PORT=XXXX`.

## WSDL

```
http://localhost:4802/?wsdl
```

Also served at `http://localhost:4802/patient?wsdl` (both paths work).

## Operations

| Operation | Happy-path input | Fault triggers |
|---|---|---|
| `GetPatient` | `<id>P001</id>` | `id=INVALID` → `PatientNotFound` |
| `CreatePatient` | `Name`, `DateOfBirth`, `MRN` | `MRN=DUP001` → `DuplicateMRN`; blank `Name` → `ValidationError` |
| `UpdatePatient` | `id=P001`, `Name`, `DateOfBirth` | `id=INVALID` → `PatientNotFound` |
| `ListPatients` | optional `<Status>active</Status>` | — |
| `DeletePatient` | `<id>P001</id>` | `id=INVALID` → `PatientNotFound` |

## Example requests

**GetPatient — happy path**

```bash
curl -s -X POST http://localhost:4802/patient \
  -H "Content-Type: text/xml" \
  -H 'SOAPAction: "http://pulseboard.soap/patient/GetPatient"' \
  -d '<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:tns="http://pulseboard.soap/patient">
  <soapenv:Body>
    <tns:GetPatientRequest><tns:id>P001</tns:id></tns:GetPatientRequest>
  </soapenv:Body>
</soapenv:Envelope>'
```

**GetPatient — PatientNotFound fault**

```bash
curl -s -X POST http://localhost:4802/patient \
  -H "Content-Type: text/xml" \
  -H 'SOAPAction: "http://pulseboard.soap/patient/GetPatient"' \
  -d '<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:tns="http://pulseboard.soap/patient">
  <soapenv:Body>
    <tns:GetPatientRequest><tns:id>INVALID</tns:id></tns:GetPatientRequest>
  </soapenv:Body>
</soapenv:Envelope>'
```

Expected response contains `<faultcode>PatientNotFound</faultcode>`.

## Using with SoapUI

1. Start the server (`npm run start:pulseboard-soap`).
2. Run the Healix codegen to generate the SoapUI project:
   ```bash
   node -e "
   require('./testbot-mcp/src/soap/soap-tier0').runSoapTier0({
     projectPath: 'compat-fixtures/pulseboard-soap',
     outputDir: '/tmp/healix-soap-out'
   }).then(r => console.log(r));
   "
   ```
3. Open `/tmp/healix-soap-out/PatientService/PatientService-soapui-project.xml` in SoapUI 5.x.
4. Run the **PatientService Tests** test suite — expect 14 active test cases.
   - 5 happy-path cases (one per operation) should pass with green status.
   - 9 fault/boundary/filter cases should catch `SOAP Fault Assertion`.

## In-memory data

The server starts with three pre-seeded patients (`P001`–`P003`). `CreatePatient` appends new records to an in-memory array that resets on server restart.
