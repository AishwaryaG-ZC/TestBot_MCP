# Playwright MCP Integration Guide

## Overview

TestBot now integrates with the official Microsoft Playwright MCP server to capture comprehensive test artifacts including traces, videos, and screenshots. Tests can run in parallel using both direct Playwright execution (fast) and Playwright MCP (full artifact capture).

## Setup

### 1. Install Playwright MCP

The package is already installed in the project. If you need to reinstall:

```bash
npm install --save-dev @playwright/mcp
```

### 2. Configure Cursor MCP

The Playwright MCP server is configured in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": [
        "/Users/krishsharma/Desktop/QA_Final/node_modules/@playwright/mcp/cli.js",
        "--save-trace",
        "--save-video=1280x720",
        "--output-dir=playwright-mcp-output",
        "--output-mode=file",
        "--headless"
      ],
      "env": {},
      "cwd": "/Users/krishsharma/Desktop/QA_Final"
    }
  }
}
```

**Important:** Restart Cursor after modifying MCP configuration.

### 3. Enable Parallel Execution

Add to your `.env` file:

```bash
# Enable Playwright MCP parallel execution
PLAYWRIGHT_MCP_ENABLED=true
PLAYWRIGHT_MCP_PARALLEL=true
PLAYWRIGHT_MCP_OUTPUT_DIR=playwright-mcp-output
```

### 4. Configure Maximum Artifact Capture

Your `playwright.config.js` should have:

```javascript
use: {
  baseURL: 'http://localhost:3000',
  trace: 'on',              // Always capture traces
  screenshot: 'on',         // Always capture screenshots
  video: 'on',              // Always capture videos
}
```

## How It Works

### Parallel Execution Architecture

```
Test Request
    │
    ├──► TestBot Direct Execution (fast)
    │         │
    │         └──► test-results.json
    │         └──► test-results/ (basic artifacts)
    │
    └──► Playwright MCP Execution (parallel)
              │
              └──► playwright-mcp-output/
                    ├── traces/
                    ├── videos/
                    └── screenshots/
                              │
                              ▼
                    Results Merger
                              │
                              ▼
                    Unified Report
                              │
                              ▼
                    Dashboard with all artifacts
```

### When Tests Run

1. **Both enabled (PLAYWRIGHT_MCP_PARALLEL=true)**
   - Tests execute in parallel via both methods
   - Results automatically merged
   - All artifacts collected and consolidated

2. **Only direct (PLAYWRIGHT_MCP_PARALLEL=false)**
   - Single execution path
   - Faster but fewer artifacts

## Using the Dashboard

### Viewing Artifacts

After tests complete, the dashboard displays:

1. **Screenshots**: Click to view full size
2. **Videos**: Play inline with controls
3. **Traces**: Click "View Trace" button
4. **Full Playwright Report**: Click "View Full Playwright Report" in the footer

### Viewing Traces

Traces are Playwright's most powerful debugging tool. They contain:
- Step-by-step test execution
- Network requests and responses
- Console logs
- DOM snapshots at each step

**To view a trace:**

**Option 1: Full Playwright HTML Report (Recommended)**
1. Click "View Full Playwright Report" button in the dashboard footer
2. Browse all tests with integrated trace viewer
3. Click on any test to see its trace, videos, and screenshots
4. Use the timeline to navigate test execution

**Option 2: Individual Trace in Dashboard**
1. Click "View Trace" button for a specific test in the dashboard
2. Follow instructions to open https://trace.playwright.dev/
3. Drag and drop the trace file

**Option 3: Command Line**
```bash
npx playwright show-trace path/to/trace.zip
```

### Full Playwright HTML Report

The "View Full Playwright Report" button in the dashboard footer opens the complete Playwright HTML report, which provides:

- **Interactive Test List**: Filter and search all tests
- **Integrated Trace Viewer**: Click any test to view its trace inline
- **Artifact Gallery**: All screenshots, videos, and traces organized by test
- **Test Timeline**: Visualize test execution order and parallelization
- **Network & Console Logs**: Complete debugging information
- **Retries & Flakiness**: Track which tests were retried and why

This report is automatically generated when tests run and copied to the `testbot-reports/` directory for easy access.

## Artifact Locations

### TestBot Direct Execution
```
test-results/
  ├── test-name-chromium/
  │   ├── screenshot-1.png
  │   └── video.webm
```

### Playwright MCP Execution
```
playwright-mcp-output/
  ├── traces/
  │   └── trace-session-123.zip
  ├── videos/
  │   └── video-123.webm
  └── screenshots/
      └── screenshot-123.png
```

### Consolidated Report
```
testbot-reports/
  ├── latest.json          # Merged test results
  └── artifacts/
      ├── screenshots/     # All screenshots
      ├── videos/          # All videos
      └── traces/          # All trace files
```

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYWRIGHT_MCP_ENABLED` | `false` | Enable MCP integration |
| `PLAYWRIGHT_MCP_PARALLEL` | `false` | Run both direct + MCP in parallel |
| `PLAYWRIGHT_MCP_OUTPUT_DIR` | `playwright-mcp-output` | MCP artifact directory |

## Troubleshooting

### MCP Server Won't Start

**Error:** `Cannot find module 'playwright/lib/mcp/program'`

**Solution:** 
1. Ensure @playwright/mcp is installed locally: `npm install --save-dev @playwright/mcp`
2. Verify MCP config uses absolute path to local installation
3. Restart Cursor

### No Artifacts Collected

**Check:**
1. `PLAYWRIGHT_MCP_ENABLED=true` in .env
2. Playwright config has `trace: 'on'`, `screenshot: 'on'`, `video: 'on'`
3. Tests actually ran (check console output)
4. Artifact directories exist and have write permissions

### Tests Take Too Long

Parallel execution with full artifacts takes longer. To optimize:

1. **Disable MCP for fast feedback:**
   ```bash
   PLAYWRIGHT_MCP_PARALLEL=false
   ```

2. **Reduce artifact capture:**
   ```javascript
   use: {
     trace: 'on-first-retry',
     screenshot: 'only-on-failure',
     video: 'retain-on-failure',
   }
   ```

### Dashboard Shows No Traces

1. Check `playwright-mcp-output/traces/` has .zip files
2. Verify report generator copied artifacts
3. Look in `testbot-reports/artifacts/traces/`
4. Check browser console for errors

## Performance Considerations

### Storage

Full artifact capture uses significant disk space:
- Traces: ~5-10MB per test
- Videos: ~1-5MB per test
- Screenshots: ~100-500KB per test

**Recommendation:** Set up periodic cleanup:
```bash
# Clean artifacts older than 7 days
find testbot-reports/artifacts -mtime +7 -delete
find playwright-mcp-output -mtime +7 -delete
```

### Execution Time

- **Direct only:** ~1x baseline
- **Parallel execution:** ~1.5x baseline (runs both simultaneously)
- **MCP only:** ~2x baseline (full artifact capture)

## API Reference

### PlaywrightMCPIntegration

```javascript
const mcp = new PlaywrightMCPIntegration({
  projectPath: '/path/to/project',
  baseURL: 'http://localhost:3000',
  outputDir: 'playwright-mcp-output',
  saveTrace: true,
  saveVideo: true
});

// Check if MCP is available
const available = await mcp.checkAvailability();

// Run tests with full artifacts
const results = await mcp.runTests();
```

### ResultsMerger

```javascript
const merger = new ResultsMerger({
  projectPath: '/path/to/project',
  prioritizeSource: 'playwright-mcp'  // or 'direct'
});

// Merge results from both sources
const merged = merger.mergeResults(directResults, mcpResults);
```

## Best Practices

1. **Use parallel execution in CI/CD** for comprehensive coverage
2. **Use direct execution for rapid development** to get fast feedback
3. **Always capture traces for flaky tests** to debug intermittent failures
4. **Set up artifact retention policies** to manage disk usage
5. **Use trace viewer to debug failures** instead of adding console.logs

## Support

For issues or questions:
1. Check logs in `testbot-reports/`
2. Review browser console (F12)
3. Check MCP logs in Cursor's output panel
4. Verify all environment variables are set correctly
