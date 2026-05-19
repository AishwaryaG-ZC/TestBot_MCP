#!/usr/bin/env node
'use strict';

/**
 * Standalone MCP server that exposes exactly ONE tool — `ask_user_question` —
 * to a `claude` subprocess via stdio.
 *
 * Invoked by `claude --mcp-config <tempPath>` (see `ask-user.js#writeMcpConfig`).
 * When Claude calls this tool mid-generation, we:
 *   1. POST the question to the Healix webapp as an `awaiting_user_question`
 *      phase event (so the dashboard can render a modal).
 *   2. Long-poll `GET /api/test-runs/{runId}/pending-answer?questionId=X` until
 *      the user submits an answer in the dashboard.
 *   3. Return the answer to Claude as the tool result string.
 *
 * Environment (set by the adapter via mcp-config env block):
 *   HEALIX_API_URL  — webapp base URL
 *   HEALIX_API_KEY  — MCP-auth key
 *   HEALIX_RUN_ID   — the active test_run.id
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const WebappClient = require('../../webapp-client');
const AskUser = require('./ask-user');

function getEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return v;
}

async function main() {
  const apiUrl = getEnv('HEALIX_API_URL', null);
  const apiKey = getEnv('HEALIX_API_KEY', null);
  const runId = getEnv('HEALIX_RUN_ID', null);

  // Even if config is missing we still register the tool — Claude expects
  // the tool to exist. Calls will then return a clear error string.
  let client = null;
  if (apiUrl && apiKey) {
    client = new WebappClient({ apiKey, dashboardUrl: apiUrl });
  }

  const server = new McpServer({
    name: 'healix-ask-user',
    version: '1.0.0',
  });

  server.registerTool(
    'ask_user_question',
    {
      title: 'Ask the human a clarifying question',
      description: 'Ask only for blocking QA ambiguity; returns the human answer.',
      inputSchema: {
        question: z.string().describe('Plain question.'),
        options: z.array(z.string()).optional().describe('Optional choices.'),
        confidence: z.number().min(0).max(1).optional().describe('0-1 default confidence.'),
      },
    },
    async ({ question, options, confidence }) => {
      if (!client || !runId) {
        return {
          content: [{
            type: 'text',
            text: 'ask_user_question is not configured (missing HEALIX_API_URL / HEALIX_API_KEY / HEALIX_RUN_ID). Proceed with the most sensible default.',
          }],
          isError: true,
        };
      }

      const questionId = AskUser.generateQuestionId(runId, question);
      try {
        const { answer } = await AskUser.postAndAwaitAnswer({
          client,
          runId,
          questionId,
          question,
          options: Array.isArray(options) ? options : [],
          confidence: typeof confidence === 'number' ? confidence : null,
        });
        return {
          content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Could not get an answer (${err?.code || 'ERROR'}: ${err?.message || 'unknown'}). The Healix run is paused for user input; do not guess or reduce coverage.`,
          }],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[ask-user-mcp-server] fatal: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
}

module.exports = { main };
