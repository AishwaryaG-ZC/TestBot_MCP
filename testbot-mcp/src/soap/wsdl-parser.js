'use strict';

const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['operation', 'message', 'part', 'fault', 'Patients'].includes(name),
  allowBooleanAttributes: true,
};

/**
 * Parse a WSDL XML string into a structured JS object.
 *
 * @param {string} wsdlXml
 * @returns {{
 *   serviceName: string,
 *   targetNamespace: string,
 *   endpoint: string,
 *   operations: Array<{
 *     name: string,
 *     soapAction: string,
 *     inputParts: Array<{name:string, type:string}>,
 *     outputParts: Array<{name:string, type:string}>,
 *     faults: Array<{name:string, message:string}>
 *   }>,
 *   types: object
 * }}
 */
function parseWsdl(wsdlXml) {
  const parser = new XMLParser(PARSER_OPTIONS);
  let doc;
  try {
    doc = parser.parse(wsdlXml);
  } catch (e) {
    return { serviceName: '', targetNamespace: '', endpoint: '', operations: [], types: {} };
  }

  // WSDL root can appear as 'definitions' or with namespace prefix
  const root = doc['definitions'] || doc['wsdl:definitions'] ||
    Object.values(doc).find(v => v && typeof v === 'object' && (v['@_targetNamespace'] !== undefined));

  if (!root) return { serviceName: '', targetNamespace: '', endpoint: '', operations: [], types: {} };

  const serviceName     = root['@_name'] || '';
  const targetNamespace = root['@_targetNamespace'] || '';

  // Build message map: messageName -> parts[]
  const rawMessages = toArray(root['message'] || root['wsdl:message'] || []);
  const messageMap  = buildMessageMap(rawMessages);

  // Build soapAction map from binding
  const rawBinding  = first(root['binding'] || root['wsdl:binding'] || []);
  const soapActions = buildSoapActionMap(rawBinding);

  // Extract endpoint from service
  const endpoint = extractEndpoint(root);

  // Extract operations from portType
  const rawPortType  = first(root['portType'] || root['wsdl:portType'] || []);
  const rawOps       = toArray((rawPortType && (rawPortType['operation'] || rawPortType['wsdl:operation'])) || []);

  const operations = rawOps.map(op => {
    const name = op['@_name'] || '';

    const inputMsg  = msgName(op['input']  || op['wsdl:input']);
    const outputMsg = msgName(op['output'] || op['wsdl:output']);
    const faultDefs = toArray(op['fault'] || op['wsdl:fault'] || []);

    return {
      name,
      soapAction: soapActions[name] || `${targetNamespace}/${name}`,
      inputParts:  (messageMap[localName(inputMsg)]  || []),
      outputParts: (messageMap[localName(outputMsg)] || []),
      faults: faultDefs.map(f => ({
        name:    f['@_name']    || '',
        message: localName(msgName(f)) || f['@_name'] || '',
      })),
    };
  });

  // Extract raw types for reference
  const typesRoot = root['types'] || root['wsdl:types'] || {};
  const schema    = typesRoot['xsd:schema'] || typesRoot['xs:schema'] || typesRoot['schema'] || {};

  return { serviceName, targetNamespace, endpoint, operations, types: schema };
}

/**
 * Parse a WSDL file from disk.
 * @param {string} wsdlPath
 */
function parseWsdlFile(wsdlPath) {
  const xml = fs.readFileSync(wsdlPath, 'utf-8');
  return parseWsdl(xml);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function first(val) {
  const arr = toArray(val);
  return arr[0] || null;
}

function localName(qname) {
  if (!qname) return '';
  const idx = qname.lastIndexOf(':');
  return idx >= 0 ? qname.slice(idx + 1) : qname;
}

function msgName(node) {
  if (!node) return '';
  return (node['@_message'] || '').trim();
}

function buildMessageMap(rawMessages) {
  const map = {};
  for (const msg of rawMessages) {
    const name  = msg['@_name'] || '';
    const parts = toArray(msg['part'] || msg['wsdl:part'] || []);
    map[name] = parts.map(p => ({
      name: p['@_name']    || '',
      type: p['@_type']    || p['@_element'] || '',
    }));
  }
  return map;
}

function buildSoapActionMap(rawBinding) {
  if (!rawBinding) return {};
  const map = {};
  const ops = toArray(rawBinding['operation'] || rawBinding['wsdl:operation'] || []);
  for (const op of ops) {
    const name       = op['@_name'] || '';
    const soapOpNode = op['soap:operation'] || op['soap12:operation'] || {};
    const action     = soapOpNode['@_soapAction'] || '';
    if (name) map[name] = action;
  }
  return map;
}

function extractEndpoint(root) {
  const svc  = first(root['service']  || root['wsdl:service']  || []);
  const port = first((svc && (svc['port'] || svc['wsdl:port'])) || []);
  if (!port) return '';
  const addr = port['soap:address'] || port['soap12:address'] || port['address'] || {};
  return addr['@_location'] || '';
}

module.exports = { parseWsdl, parseWsdlFile };
