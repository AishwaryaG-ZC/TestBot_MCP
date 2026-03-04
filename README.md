# Testbot MCP

**One-command testing with AI-powered analysis for any project.**

Testbot MCP is a Model Context Protocol (MCP) server that enables seamless end-to-end testing with AI-powered failure analysis. Just say "test my app using testbot mcp" in Cursor or Windsurf, and Testbot handles everything automatically.

## Features

- **One Command Testing**: Simply ask your AI assistant to test your app
- **Playwright Integration**: Uses the official Playwright MCP for test generation and execution
- **AI-Powered Analysis**: Automatically analyzes test failures using Sarvam, Cascade, or Windsurf AI
- **Beautiful Dashboard**: Auto-opens a dashboard with screenshots, videos, traces, and AI analysis
- **Zero Config**: Auto-detects project settings (port, base URL, start command)
- **Optional Jira Integration**: Fetch stories, generate tests from acceptance criteria

## Quick Start

### 1. Install

```bash
npm install -g @testbot/mcp
```

### 2. Configure MCP

Add to your MCP settings (`~/.cursor/mcp.json` or similar):

```json
{
  "mcpServers": {
    "testbot": {
      "command": "npx",
      "args": ["@testbot/mcp"],
      "env": {
        "SARVAM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### 3. Test Your App

In Cursor or Windsurf:

> "Test my app using testbot mcp"

That's it! Testbot will:
1. Auto-detect your project settings
2. Generate tests (from PRD or Jira stories if provided)
3. Run the tests
4. Analyze failures with AI
5. Open a dashboard with results

## Usage

### Basic Usage

```
User: "test my app using testbot mcp"
```

### With Options

```
User: "test my frontend using testbot mcp with sarvam AI analysis"
```

### With PRD File

```
User: "test my app using testbot mcp with the PRD at ./docs/requirements.md"
```

### With Jira Integration

```
User: "test my app using testbot mcp and fetch stories from Jira project MYAPP"
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SARVAM_API_KEY` | Sarvam AI API key for failure analysis | - |
| `AI_PROVIDER` | AI provider: `sarvam`, `cascade`, `windsurf`, or `none` | `sarvam` |
| `JIRA_BASE_URL` | Jira instance URL | - |
| `JIRA_EMAIL` | Jira account email | - |
| `JIRA_API_TOKEN` | Jira API token | - |
| `JIRA_PROJECT_KEY` | Jira project key | - |

### Tool Parameters

The `testbot_test_my_app` tool accepts:

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string | Path to project (default: workspace root) |
| `testType` | string | `frontend`, `backend`, or `both` |
| `prdFile` | string | Path to PRD file for test generation |
| `baseURL` | string | Application base URL |
| `port` | number | Application port |
| `startCommand` | string | Command to start the app |
| `aiProvider` | string | AI provider for analysis |
| `jira.enabled` | boolean | Enable Jira integration |

## Dashboard

The dashboard displays:

- **KPI Cards**: Total tests, passed, failed, skipped, pass rate, duration
- **AI Analysis Summary**: Carousel of AI-powered failure analyses
- **Suite Breakdown**: Results by test suite
- **Charts**: Status distribution and suite results
- **Test Table**: Filterable, sortable list of all tests
- **Regression Comparison**: Compare with baseline results

### Screenshots and Artifacts

Click any failed test to see:
- Error details and stack trace
- AI analysis with root cause and suggested fix
- Screenshots at time of failure
- Video recording of the test
- Playwright trace files

## Project Structure

```
testbot-mcp/
├── src/
│   ├── index.js              # MCP server entry
│   ├── auto-detector.js      # Project settings detection
│   ├── playwright-integration.js
│   ├── report-generator.js
│   ├── dashboard-launcher.js
│   ├── ai-providers/
│   │   ├── sarvam.js
│   │   ├── cascade.js
│   │   └── windsurf.js
│   └── jira/
│       └── client.js
├── package.json
└── .env.example

dashboard/
├── public/
│   └── index.html
└── src/
    ├── data-parser.js
    ├── reporter.js
    └── styles/
        └── dashboard.css
```

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md)
- [User Guide](docs/USER_GUIDE.md)
- [API Reference](docs/API_REFERENCE.md)

## License

MIT
# TestBot_MCP
# TestBot_MCP
