const { spawn } = require('child_process');

const mcpProcess = spawn('node', ['src/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

mcpProcess.stdout.on('data', (data) => console.log(`STDOUT: ${data}`));
mcpProcess.stderr.on('data', (data) => console.error(`STDERR: ${data}`));

// Send the JSON-RPC initialization
mcpProcess.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" }
  }
}) + "\n");

// Send the test tool execution
setTimeout(() => {
  mcpProcess.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "testbot_test_my_app",
      arguments: {
        projectPath: "c:\\Users\\ShreyesPrabhuDesai\\PersProjects\\thea"
      }
    }
  }) + "\n");
}, 1000);
