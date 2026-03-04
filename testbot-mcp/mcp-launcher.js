#!/usr/bin/env node
/**
 * MCP Launcher - Forces fresh module loading
 * This wrapper ensures Windsurf loads the latest code
 */

// Clear module cache to force fresh load
delete require.cache[require.resolve('./src/index.js')];

// Force stderr output for debugging
console.error('[MCP-LAUNCHER] Starting TestBot MCP with fresh module load...');
console.error('[MCP-LAUNCHER] Timestamp:', new Date().toISOString());

// Load and start the server
require('./src/index.js');
