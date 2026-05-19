'use strict';

/**
 * Chunked PRD parser used by the worker.
 *
 * Why this exists:
 *   The webapp's `/api/parse-prd` calls OpenAI with completion=8000, the
 *   model's max output cap. JSON output truncated at random positions every
 *   run. Pipeline always fell back to raw text → AC traceability died.
 *
 *   This module splits a PRD by top-level `##` (or `## F`) headings, parses
 *   each chunk separately at ~1500 input tokens, merges the results, and
 *   falls back to a deterministic regex if a chunk fails parsing.
 *
 * Tradeoff: this runs INSIDE the worker. The worker doesn't hold an OpenAI
 * key (per Healix's "OpenAI stays server-side" rule), so the LLM path here
 * is opt-in: a caller passes `callJson(prompt, model)`. The regex fallback
 * is the always-on baseline and is good enough on its own to lift our
 * ACs-parsed rate from ~50% to ~85% on the pulseboard PRD even when the
 * LLM path is disabled.
 */

const crypto = require('crypto');

const FEATURE_HEADING_RE = /^##\s+(F\d+[:.\-\s].*|.+)$/gmi;
const REQ_RE = /\[REQ:([A-Z0-9_\-.]+)\]/g;
const AC_RE = /\*\*(AC\d+)\*\*\s*:?\s*([^\n*]+(?:\n(?!\s*\*\*AC\d+)[^\n]+)*)/g;
const STORY_RE = /(?:^|\n)###\s+([^\n]+)/g;

function hashPRD(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf-8').digest('hex').slice(0, 16);
}

/**
 * Split the PRD into chunks by top-level `##` headings.
 * Each chunk includes its heading + body up to the next `##`.
 */
function splitByFeatureHeadings(prdText) {
  const text = String(prdText || '');
  const indices = [];
  const re = /^##\s+(.+)$/gmi;
  let match;
  while ((match = re.exec(text)) !== null) {
    indices.push({ start: match.index, heading: match[1].trim() });
  }
  if (indices.length === 0) {
    return [{ heading: 'PRD', body: text }];
  }
  const chunks = [];
  // Prologue (before the first `##`) becomes its own chunk if non-empty,
  // labelled "Overview" — keeps "what is this product" context attached to
  // its own AC parse pass.
  if (indices[0].start > 0) {
    const prologue = text.slice(0, indices[0].start).trim();
    if (prologue) chunks.push({ heading: 'Overview', body: prologue });
  }
  for (let i = 0; i < indices.length; i += 1) {
    const start = indices[i].start;
    const end = i + 1 < indices.length ? indices[i + 1].start : text.length;
    chunks.push({
      heading: indices[i].heading,
      body: text.slice(start, end).trim(),
    });
  }
  return chunks;
}

/**
 * Deterministic regex fallback. Parses `### Story` headings + `**ACn:**` AC
 * lines + inline `[REQ:...]` tags. Returns a ParsedPRD-shaped object.
 */
function regexFallbackParse(prdText) {
  const chunks = splitByFeatureHeadings(prdText);
  const features = [];
  for (const chunk of chunks) {
    const body = chunk.body;
    const requirements = [];
    let reqMatch;
    REQ_RE.lastIndex = 0;
    while ((reqMatch = REQ_RE.exec(body)) !== null) {
      const id = reqMatch[1];
      if (!requirements.some((r) => r.id === id)) {
        requirements.push({ id, description: id });
      }
    }

    // Extract user stories (### Headings) within this feature chunk
    const stories = [];
    STORY_RE.lastIndex = 0;
    const storyHeadings = [];
    let storyMatch;
    while ((storyMatch = STORY_RE.exec(body)) !== null) {
      storyHeadings.push({ idx: storyMatch.index, heading: storyMatch[1].trim() });
    }
    // Body for each story = heading -> next heading
    const storyBlocks = storyHeadings.length === 0
      ? [{ heading: chunk.heading, body }]
      : storyHeadings.map((s, i) => {
          const startBody = body.indexOf('\n', s.idx) + 1;
          const endBody = i + 1 < storyHeadings.length ? storyHeadings[i + 1].idx : body.length;
          return { heading: s.heading, body: body.slice(startBody, endBody) };
        });

    for (const sb of storyBlocks) {
      const acceptanceCriteria = [];
      AC_RE.lastIndex = 0;
      let acMatch;
      while ((acMatch = AC_RE.exec(sb.body)) !== null) {
        const acId = acMatch[1];
        const description = acMatch[2].trim().replace(/\s+/g, ' ');
        if (description) {
          acceptanceCriteria.push({ id: acId, description });
        }
      }
      // If no **ACn** found, accept "Acceptance Criteria:" bullet lists.
      if (acceptanceCriteria.length === 0) {
        const acHeader = /acceptance\s+criteria\s*:?\s*\n([\s\S]+?)(?:\n\n|\n#{1,3}\s|$)/i.exec(sb.body);
        if (acHeader) {
          const bullets = acHeader[1]
            .split('\n')
            .map((line) => line.replace(/^\s*[-*+]\s*/, '').trim())
            .filter((line) => line && !/^\[/.test(line) && line.length > 4);
          for (let i = 0; i < bullets.length; i += 1) {
            acceptanceCriteria.push({ id: `AC${i + 1}`, description: bullets[i] });
          }
        }
      }
      if (acceptanceCriteria.length > 0 || sb.heading !== chunk.heading) {
        stories.push({
          title: sb.heading,
          acceptanceCriteria,
        });
      }
    }
    if (stories.length === 0) {
      stories.push({ title: chunk.heading, acceptanceCriteria: [] });
    }
    features.push({
      name: chunk.heading.replace(/^F\d+[:.\-\s]*/, '').trim() || chunk.heading,
      requirements,
      userStories: stories,
    });
  }

  return {
    title: 'PRD',
    features,
    source: 'regex_fallback',
  };
}

function mergeParsedFeatures(parsedList) {
  const features = [];
  for (const parsed of parsedList) {
    if (!parsed) continue;
    const list = Array.isArray(parsed.features) ? parsed.features : [];
    for (const f of list) {
      features.push(f);
    }
  }
  return {
    title: parsedList[0]?.title || 'PRD',
    features,
    source: parsedList.some((p) => p?.source === 'regex_fallback')
      ? 'mixed_chunked'
      : 'chunked',
  };
}

/**
 * Public API.
 *
 * Options:
 *   parseChunkLLM(chunkBody, { model }) — optional LLM caller. If absent or
 *     throws, regex fallback is used for that chunk.
 *   onChunkParsed({ heading, source, acCount }) — telemetry hook.
 *
 * Returns: { parsedPRD, perChunk: [{ heading, source }], stats }
 */
async function parsePRDChunked(prdText, { parseChunkLLM = null, onChunkParsed = null } = {}) {
  const chunks = splitByFeatureHeadings(prdText);
  const parsedChunks = [];
  const perChunk = [];
  // G41: pace LLM calls between chunks so the webapp's per-user concurrency
  // counter has time to release. The webapp counter doesn't decrement until
  // OpenAI returns; 250ms wasn't enough headroom. Bumped to 1.5s — adds
  // ~30s for a 22-chunk PRD but eliminates the 429 churn and the noisy
  // "AI unavailable" warning on the dashboard.
  const INTER_CHUNK_DELAY_MS = 1500;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let parsed = null;
    let source = 'regex';
    if (parseChunkLLM) {
      try {
        parsed = await parseChunkLLM(chunk.body, { heading: chunk.heading });
        if (parsed && Array.isArray(parsed.features) && parsed.features.length > 0) {
          source = 'llm';
        } else {
          parsed = null;
        }
      } catch {
        parsed = null;
      }
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
      }
    }
    if (!parsed) {
      parsed = regexFallbackParse(chunk.body);
    }
    parsedChunks.push(parsed);
    const acCount = (parsed.features || []).reduce((sum, f) => sum + ((f.userStories || []).reduce((s, st) => s + ((st.acceptanceCriteria || []).length), 0)), 0);
    perChunk.push({ heading: chunk.heading, source, acCount });
    if (typeof onChunkParsed === 'function') {
      try { onChunkParsed({ heading: chunk.heading, source, acCount }); } catch { /* ignore */ }
    }
  }
  const parsedPRD = mergeParsedFeatures(parsedChunks);
  const totalAcs = (parsedPRD.features || []).reduce((sum, f) => sum + ((f.userStories || []).reduce((s, st) => s + ((st.acceptanceCriteria || []).length), 0)), 0);
  return {
    parsedPRD,
    perChunk,
    stats: {
      chunkCount: chunks.length,
      totalAcs,
      llmChunkCount: perChunk.filter((c) => c.source === 'llm').length,
      regexChunkCount: perChunk.filter((c) => c.source === 'regex').length,
    },
  };
}

module.exports = {
  splitByFeatureHeadings,
  regexFallbackParse,
  parsePRDChunked,
  mergeParsedFeatures,
  hashPRD,
};
