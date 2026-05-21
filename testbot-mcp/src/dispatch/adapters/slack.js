'use strict';

const https = require('https');
const { URL } = require('url');

function buildSlackText(finding) {
  const reproducer = finding.reproducer?.command ? `\nReproducer: \`${finding.reproducer.command}\`` : '';
  return `[${finding.severity}] ${finding.title}\nFile: ${finding.testFile || finding.ownerHint || 'unknown'}${reproducer}`;
}

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('slack_request_timeout')); });
    req.write(data);
    req.end();
  });
}

async function dispatch(finding, config) {
  try {
    const { statusCode } = await postJson(config.webhook, { text: buildSlackText(finding) });
    if (statusCode >= 200 && statusCode < 300) return { ok: true };
    return { ok: false, error: `slack_http_${statusCode}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { dispatch };
