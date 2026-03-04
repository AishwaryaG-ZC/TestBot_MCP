const test = require('node:test');
const assert = require('node:assert/strict');

const PlaywrightMCPIntegration = require('../src/playwright-mcp-integration');

test('getMcpPackageSpecifier never returns @latest suffix', () => {
  const integration = new PlaywrightMCPIntegration({ mcpVersion: 'latest' });
  assert.equal(integration.getMcpPackageSpecifier(), '@playwright/mcp');
});

test('buildNpxArgs includes --no-install by default', () => {
  const integration = new PlaywrightMCPIntegration({ mcpVersion: '0.0.23' });
  const args = integration.buildNpxArgs(['--help']);
  assert.equal(args[0], '--no-install');
  assert.equal(args[1], '@playwright/mcp@0.0.23');
});

test('getServerConfig resolves pinned package spec', () => {
  const config = PlaywrightMCPIntegration.getServerConfig({
    mcpVersion: '0.0.23',
    noInstall: true,
  });

  assert.equal(config.command, 'npx');
  assert.equal(config.args[0], '--no-install');
  assert.equal(config.args[1], '@playwright/mcp@0.0.23');
});
