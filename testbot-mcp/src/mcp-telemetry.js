const fetch = global.fetch || require('node-fetch');
const Logger = require('./logger');

const MAX_STRING_LENGTH = 600;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_METADATA_BYTES = 32000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function normalizeLocalhost(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '::1') {
      u.hostname = '127.0.0.1';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return String(url).replace(/\/+$/, '');
  }
}

function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

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
    const apiKey = config.apiKey || process.env.HEALIX_API_KEY || null;
    const dashboardUrl = normalizeLocalhost(config.dashboardUrl || process.env.HEALIX_DASHBOARD_URL || null);
    const telemetryEnv = String(process.env.HEALIX_MCP_TELEMETRY || '').trim().toLowerCase();
    const enabledByEnv = telemetryEnv ? !['0', 'false', 'off', 'no'].includes(telemetryEnv) : true;
    const explicitEnable = config.enabled;
    const enabled = explicitEnable !== undefined ? explicitEnable : enabledByEnv;
    const explicitTimeout = config.timeoutMs || process.env.HEALIX_MCP_TELEMETRY_TIMEOUT_MS;

    this.config = {
      apiKey,
      dashboardUrl,
      source: config.source || 'healix-mcp',
      timeoutMs: Number(explicitTimeout || (isLocalUrl(dashboardUrl) ? 12000 : 2500)),
      enabled: enabled && !!apiKey && !!dashboardUrl && !isTestRuntime(),
      maxQueueSize: Number(config.maxQueueSize || process.env.HEALIX_MCP_TELEMETRY_QUEUE_SIZE || 500),
    };
    this.queue = [];
    this.processing = false;
    this.drainResolvers = [];
    this.workspaceId = config.workspaceId || null;
  }

  isEnabled() {
    return this.config.enabled;
  }

  setWorkspaceId(wsId) {
    this.workspaceId = wsId || null;
  }

  sanitizeEvent(input = {}) {
    const status = inferStatus(input);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const rawMetadata = this.workspaceId
      ? { workspaceId: this.workspaceId, ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}) }
      : input.metadata;

    return {
      source: clampString(this.config.source, 80),
      toolName: clampString(input.toolName || 'healix_test_my_app', 120),
      eventType: clampString(input.eventType || 'status', 80),
      runId: clampString(input.runId, 160),
      phase: clampString(input.phase, 120),
      status: clampString(status, 40),
      success: typeof input.success === 'boolean' ? input.success : status === 'success',
      errorCode: clampString(input.errorCode, 120),
      reason: clampString(input.reason, 500),
      message: clampString(input.message, MAX_MESSAGE_LENGTH),
      durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : undefined,
      metadata: normalizeMetadata(rawMetadata),
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

    const maxQueueSize = Number.isFinite(this.config.maxQueueSize)
      ? Math.max(1, this.config.maxQueueSize)
      : 500;
    if (this.queue.length >= maxQueueSize) {
      this.queue.shift();
    }
    this.queue.push(event);
    this.processQueue();
  }

  processQueue() {
    if (this.processing || !this.config.enabled) {
      return;
    }
    this.processing = true;
    setImmediate(async () => {
      try {
        while (this.queue.length > 0) {
          const event = this.queue.shift();
          try {
            await this.emit(event);
          } catch (error) {
            const rateLimited = /429|RATE_LIMIT/i.test(String(error?.message || ''));
            const attempts = Number(event?.__telemetryAttempts || 0);
            if (rateLimited && attempts < 3) {
              this.queue.unshift({ ...event, __telemetryAttempts: attempts + 1 });
              await new Promise((resolve) => setTimeout(resolve, 1000 * (attempts + 1)));
              continue;
            }
            Logger.warn('MCPTelemetryReporter', 'Telemetry emit failed', {
              reason: error.message,
              eventType: event?.eventType,
              phase: event?.phase,
              runId: event?.runId,
            });
          }
        }
      } finally {
        this.processing = false;
        if (this.queue.length > 0) {
          this.processQueue();
        } else {
          const resolvers = this.drainResolvers.splice(0);
          resolvers.forEach((resolve) => resolve());
        }
      }
    });
  }

  async drain(timeoutMs = 5000) {
    if (!this.config.enabled || (this.queue.length === 0 && !this.processing)) {
      return { drained: true };
    }

    return await Promise.race([
      new Promise((resolve) => {
        this.drainResolvers.push(() => resolve({ drained: true }));
      }),
      new Promise((resolve) => {
        setTimeout(() => resolve({ drained: false, queued: this.queue.length }), Math.max(100, timeoutMs));
      }),
    ]);
  }
}

module.exports = MCPTelemetryReporter;
