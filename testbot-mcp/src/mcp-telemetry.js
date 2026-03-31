const fetch = global.fetch || require('node-fetch');
const Logger = require('./logger');

const MAX_STRING_LENGTH = 600;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_METADATA_BYTES = 32000;

function clampString(value, maxLength = MAX_STRING_LENGTH) {
  if (value === null || value === undefined) return undefined;
  const str = String(value);
  if (!str) return undefined;
  return str.length > maxLength ? str.slice(0, maxLength) : str;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(metadata);
    if (serialized.length <= MAX_METADATA_BYTES) {
      return metadata;
    }

    // Best-effort truncation for oversized metadata payloads.
    return {
      __truncated: true,
      preview: serialized.slice(0, MAX_METADATA_BYTES),
    };
  } catch {
    return undefined;
  }
}

function inferStatus(event = {}) {
  if (event.status) return String(event.status).toLowerCase();
  if (event.success === true) return 'success';
  if (event.success === false) return 'error';
  if (event.errorCode) return 'error';
  return 'info';
}

function isTestRuntime() {
  if (process.env.NODE_ENV === 'test') return true;
  return Array.isArray(process.argv) && process.argv.includes('--test');
}

class MCPTelemetryReporter {
  constructor(config = {}) {
    const apiKey = config.apiKey || process.env.TESTBOT_API_KEY || null;
    const dashboardUrl = config.dashboardUrl || process.env.TESTBOT_DASHBOARD_URL || null;
    const telemetryEnv = String(process.env.TESTBOT_MCP_TELEMETRY || '').trim().toLowerCase();
    const enabledByEnv = telemetryEnv ? !['0', 'false', 'off', 'no'].includes(telemetryEnv) : true;
    const explicitEnable = config.enabled;
    const enabled = explicitEnable !== undefined ? explicitEnable : enabledByEnv;

    this.config = {
      apiKey,
      dashboardUrl,
      source: config.source || 'testbot-mcp',
      timeoutMs: Number(config.timeoutMs || process.env.TESTBOT_MCP_TELEMETRY_TIMEOUT_MS || 2500),
      enabled: enabled && !!apiKey && !!dashboardUrl && !isTestRuntime(),
    };
  }

  isEnabled() {
    return this.config.enabled;
  }

  sanitizeEvent(input = {}) {
    const status = inferStatus(input);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();

    return {
      source: clampString(this.config.source, 80),
      toolName: clampString(input.toolName || 'testbot_test_my_app', 120),
      eventType: clampString(input.eventType || 'status', 80),
      runId: clampString(input.runId, 160),
      phase: clampString(input.phase, 120),
      status: clampString(status, 40),
      success: typeof input.success === 'boolean' ? input.success : status === 'success',
      errorCode: clampString(input.errorCode, 120),
      reason: clampString(input.reason, 500),
      message: clampString(input.message, MAX_MESSAGE_LENGTH),
      durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : undefined,
      metadata: normalizeMetadata(input.metadata),
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date().toISOString() : occurredAt.toISOString(),
    };
  }

  async emit(event) {
    if (!this.config.enabled) {
      return { skipped: true, reason: 'telemetry_disabled' };
    }

    const payload = {
      api_key: this.config.apiKey,
      event: this.sanitizeEvent(event),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(250, this.config.timeoutMs));

    try {
      const response = await fetch(`${this.config.dashboardUrl}/api/mcp-telemetry/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Telemetry ingest failed (${response.status}): ${text.slice(0, 200)}`);
      }

      return { success: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  emitBackground(event) {
    if (!this.config.enabled) {
      return;
    }

    this.emit(event).catch((error) => {
      Logger.warn('MCPTelemetryReporter', 'Telemetry emit failed', {
        reason: error.message,
        eventType: event?.eventType,
        phase: event?.phase,
        runId: event?.runId,
      });
    });
  }
}

module.exports = MCPTelemetryReporter;
