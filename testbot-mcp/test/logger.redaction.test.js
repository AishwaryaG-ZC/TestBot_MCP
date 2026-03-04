const test = require('node:test');
const assert = require('node:assert/strict');

const Logger = require('../src/logger');

test('Logger.redact masks nested sensitive fields without mutating input', () => {
  const input = {
    apiToken: 'abc123',
    nested: {
      password: 'super-secret',
      headers: {
        authorization: 'Bearer my-token-value',
      },
    },
    list: [
      { cookie: 'session=123' },
      { note: 'safe' },
    ],
  };

  const snapshot = JSON.parse(JSON.stringify(input));
  const redacted = Logger.redact(input);

  assert.equal(redacted.apiToken, '[REDACTED]');
  assert.equal(redacted.nested.password, '[REDACTED]');
  assert.equal(redacted.nested.headers.authorization, '[REDACTED]');
  assert.equal(redacted.list[0].cookie, '[REDACTED]');
  assert.equal(redacted.list[1].note, 'safe');

  assert.deepEqual(input, snapshot);
});

test('Logger.redact masks bearer tokens in free text strings', () => {
  const redacted = Logger.redact('Authorization: Bearer secret-token-value');
  assert.match(redacted, /Bearer \[REDACTED\]/);
});
