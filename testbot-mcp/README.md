# @testbot/mcp

One-command testing with AI-powered analysis for any project.

## Installation

```bash
npm install -g @testbot/mcp
```

## Usage

Add to your MCP configuration:

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

Then in Cursor or Windsurf:

> "Test my app using testbot mcp"

## Features

- Automatic project detection
- Playwright test generation
- AI-powered failure analysis
- Beautiful dashboard with screenshots/videos
- Optional Jira integration

## Documentation

See the [main documentation](../docs) for full details.
