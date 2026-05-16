'use strict';

/**
 * Parser for Claude Code's `--output-format stream-json` line-delimited
 * event stream.
 *
 * Wire format reference (claude 2.1.141):
 *   { "type": "system",   "subtype": "init",  "session_id": "...", ... }
 *   { "type": "assistant", "message": { "content": [ { type: "text", text: ... }
 *                                                     | { type: "tool_use", name, input, id } ] } }
 *   { "type": "user",     "message": { "content": [ { type: "tool_result", tool_use_id, content } ] } }
 *   { "type": "result",   "subtype": "success", "session_id": "...",
 *                          "total_cost_usd": 0.12, "num_turns": 7,
 *                          "usage": { input_tokens, output_tokens, ... },
 *                          "result": "DONE" }
 *   { "type": "result",   "subtype": "error_max_turns" | "error_login_required" | ... }
 *
 * Normalized events fired on the EventEmitter:
 *   - 'session_started'    { sessionId }
 *   - 'assistant_message'  { text, raw }
 *   - 'tool_use_edit'      { id, input }       (Edit tool)
 *   - 'tool_use_write'     { id, input }       (Write tool)
 *   - 'tool_use_read'      { id, input }       (Read tool)
 *   - 'tool_use_bash'      { id, input }       (Bash tool)
 *   - 'tool_use_ask_user'  { id, input }       (custom MCP tool: ask_user_question)
 *   - 'tool_use_other'     { id, name, input } (anything else, for logging)
 *   - 'tool_result'        { toolUseId, content }
 *   - 'iteration_complete' { sessionId, summary, usage, costUsd, numTurns, subtype }
 *   - 'error'              { code, message, raw }
 *
 * High-level lifecycle helpers:
 *   parser.on('event', (evt) => ...)     // catch-all of normalized events
 *   parser.on('done', (result) => ...)   // emitted exactly once when stream ends
 *   parser.on('error', (err) => ...)
 *
 *   parser.parseStream(readableStdout)   // returns a Promise resolving to the
 *                                        // final iteration_complete payload (or
 *                                        // rejecting on hard error_login_required)
 *   parser.feed(chunk)                   // for unit tests — call with strings/buffers
 *   parser.end()                         // flush trailing partial line + close
 */

const { EventEmitter } = require('node:events');

const Logger = require('../../logger');

const ASK_USER_TOOL_NAMES = new Set([
  'ask_user_question',
  'ask_user',
  'mcp__healix-ask-user__ask_user_question',
]);

class ClaudeStreamParser extends EventEmitter {
  constructor() {
    super();
    this._buffer = '';
    this._closed = false;
    this._sessionId = null;
    this._finalResult = null;
    this._finalError = null;
    this._selfDoneSeen = false;
  }

  /**
   * WS-3: did Claude end an assistant message with the literal `DONE` marker?
   * Set inside `_dispatchAssistant` when the message is exactly `DONE`
   * (case-sensitive) or ends with `\nDONE` after trimming the final line.
   */
  get selfDoneSeen() {
    return this._selfDoneSeen === true;
  }

  /**
   * Read a Node Readable (Claude's stdout) line-by-line. Resolves with the
   * `iteration_complete` payload, rejects with the captured error.
   */
  parseStream(readable) {
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        try {
          this.feed(chunk);
        } catch (err) {
          // feed only throws on truly catastrophic JSON; swallow per-line
          // parse failures internally.
          Logger.warn('ClaudeLocal/StreamParser', 'Unexpected feed error', { message: err?.message });
        }
      };
      const onEnd = () => {
        this.end();
        if (this._finalError) return reject(this._finalError);
        return resolve(this._finalResult || { sessionId: this._sessionId });
      };
      const onError = (err) => {
        readable.removeListener('data', onData);
        readable.removeListener('end', onEnd);
        readable.removeListener('error', onError);
        reject(err);
      };
      readable.on('data', onData);
      readable.once('end', onEnd);
      readable.once('error', onError);
    });
  }

  /**
   * Feed a chunk (Buffer or string) into the parser. Handles partial lines.
   */
  feed(chunk) {
    if (chunk == null) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this._buffer += text;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const rawLine = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      this._handleLine(rawLine);
    }
  }

  /**
   * Flush any trailing line, then mark the parser as closed.
   */
  end() {
    if (this._closed) return;
    if (this._buffer && this._buffer.trim()) {
      this._handleLine(this._buffer);
      this._buffer = '';
    }
    this._closed = true;
    this.emit('close');
  }

  _handleLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch (err) {
      Logger.debug('ClaudeLocal/StreamParser', 'Skipping non-JSON line', { snippet: trimmed.slice(0, 200) });
      return;
    }
    if (!evt || typeof evt !== 'object') return;
    this._dispatch(evt);
  }

  _dispatch(evt) {
    const type = evt.type;
    switch (type) {
      case 'system':
        if (evt.subtype === 'init') {
          this._sessionId = evt.session_id || evt.sessionId || null;
          this._emitNormalized('session_started', { sessionId: this._sessionId, raw: evt });
        } else {
          // Non-init system events (e.g. tool listings) — surface for logging only.
          this._emitNormalized('system_event', { subtype: evt.subtype || null, raw: evt });
        }
        return;

      case 'assistant':
        this._dispatchAssistant(evt);
        return;

      case 'user':
        this._dispatchUser(evt);
        return;

      case 'result':
        this._dispatchResult(evt);
        return;

      default:
        // Unknown event — surface for visibility.
        this._emitNormalized('unknown_event', { type, raw: evt });
        return;
    }
  }

  _dispatchAssistant(evt) {
    const content = evt?.message?.content;
    if (!Array.isArray(content)) {
      // Some shapes carry a bare string under message.content
      if (typeof evt?.message?.content === 'string') {
        const text = evt.message.content;
        this._emitNormalized('assistant_message', { text, raw: evt });
        this._maybeFlagSelfDone(text);
      }
      return;
    }
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const partType = part.type;
      if (partType === 'text') {
        const text = part.text || '';
        this._emitNormalized('assistant_message', { text, raw: part });
        // WS-3: detect Claude's "DONE" self-completion marker. Match the
        // whole-message form (`DONE` exactly) or the trailing-line form
        // ("... so I'm done.\nDONE"). Case-sensitive on purpose so the
        // word appearing mid-sentence (e.g. "the DONE bell rings") does
        // not trip the detector.
        this._maybeFlagSelfDone(text);
      } else if (partType === 'tool_use') {
        const name = part.name || '';
        const id = part.id || null;
        const input = part.input || {};
        if (ASK_USER_TOOL_NAMES.has(name) || /ask_user/i.test(name)) {
          this._emitNormalized('tool_use_ask_user', { id, name, input, raw: part });
        } else if (/^edit$/i.test(name)) {
          this._emitNormalized('tool_use_edit', { id, name, input, raw: part });
        } else if (/^write$/i.test(name)) {
          this._emitNormalized('tool_use_write', { id, name, input, raw: part });
        } else if (/^read$/i.test(name)) {
          this._emitNormalized('tool_use_read', { id, name, input, raw: part });
        } else if (/^bash$/i.test(name)) {
          this._emitNormalized('tool_use_bash', { id, name, input, raw: part });
        } else {
          this._emitNormalized('tool_use_other', { id, name, input, raw: part });
        }
      } else if (partType === 'thinking') {
        this._emitNormalized('assistant_thinking', { text: part.thinking || part.text || '', raw: part });
      }
    }
  }

  _dispatchUser(evt) {
    const content = evt?.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_result') {
        this._emitNormalized('tool_result', {
          toolUseId: part.tool_use_id || part.id || null,
          content: part.content,
          raw: part,
        });
      }
    }
  }

  _dispatchResult(evt) {
    const subtype = evt.subtype || 'success';
    if (subtype && /^error_/.test(subtype)) {
      const err = new Error(`Claude stream ended with ${subtype}`);
      err.code = subtype.toUpperCase();
      err.raw = evt;
      this._finalError = err;
      // Emit a normalized 'error' event but skip the bare emit when there are
      // no listeners — EventEmitter treats unhandled 'error' as fatal which
      // would crash callers that only listen on the 'event' bus.
      if (this.listenerCount('error') > 0) {
        this.emit('error', { code: err.code, message: err.message, raw: evt });
      }
      this.emit('event', { name: 'error', payload: { code: err.code, message: err.message, raw: evt } });
      return;
    }
    const final = {
      sessionId: evt.session_id || this._sessionId || null,
      summary: evt.result || null,
      usage: evt.usage || null,
      costUsd: evt.total_cost_usd != null ? Number(evt.total_cost_usd) : null,
      numTurns: evt.num_turns != null ? Number(evt.num_turns) : null,
      subtype,
      raw: evt,
    };
    this._finalResult = final;
    this._emitNormalized('iteration_complete', final);
  }

  _emitNormalized(name, payload) {
    this.emit(name, payload);
    this.emit('event', { name, payload });
  }

  /**
   * WS-3: scan an assistant text message for Claude's "DONE" marker. The
   * orchestrator uses this flag to short-circuit the iteration loop when
   * Claude self-evaluates as finished. Two accepted shapes:
   *   - the entire trimmed message is exactly `DONE`, OR
   *   - the message ends with `\nDONE` (final line, after trimming trailing
   *     whitespace) — e.g. "I've added the remaining specs.\nDONE".
   * Anything else (DONE mid-paragraph, lowercase, in code fences) is ignored.
   */
  _maybeFlagSelfDone(text) {
    if (typeof text !== 'string' || !text) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const trailingDone = /\nDONE\s*$/.test(text.replace(/[ \t]+$/g, ''));
    if (trimmed === 'DONE' || trailingDone) {
      this._selfDoneSeen = true;
      this._emitNormalized('claude_self_done', { text });
    }
  }
}

function createParser() {
  return new ClaudeStreamParser();
}

/**
 * Convenience: feed a synchronous Iterable<string> (canned events for tests)
 * through a new parser instance and return collected events.
 */
function collectEvents(lines) {
  const parser = new ClaudeStreamParser();
  const events = [];
  parser.on('event', (e) => events.push(e));
  for (const line of lines) {
    parser.feed(line + '\n');
  }
  parser.end();
  return { events, parser, final: parser._finalResult, error: parser._finalError };
}

module.exports = {
  ClaudeStreamParser,
  createParser,
  collectEvents,
  ASK_USER_TOOL_NAMES: [...ASK_USER_TOOL_NAMES],
};
