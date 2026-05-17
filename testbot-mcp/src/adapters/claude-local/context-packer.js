'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isArtifactFile } = require('./surface-inventory');

const DEFAULT_TOKEN_BUDGET = 120_000;
const CHARS_PER_TOKEN = 4;

function tokenBudget() {
  const env = Number.parseInt(process.env.HEALIX_CLAUDE_CONTEXT_TOKEN_BUDGET || '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TOKEN_BUDGET;
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function deepCloneJson(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function matchesSurfaceText(surface, value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  const needles = [
    surface?.surfaceKey,
    surface?.label,
    ...asArray(surface?.routes),
    ...asArray(surface?.apiEndpoints),
    ...asArray(surface?.forms),
    ...asArray(surface?.roles),
    ...asArray(surface?.sourceFiles).map((f) => path.basename(String(f))),
  ].filter(Boolean).map((v) => String(v).toLowerCase());
  return needles.some((needle) => needle && text.includes(needle));
}

function filterEntries(entries, surface, fallbackLimit) {
  const arr = asArray(entries);
  const selected = arr.filter((entry) => {
    if (!entry) return false;
    const raw = typeof entry === 'string' ? entry : JSON.stringify(entry);
    return matchesSurfaceText(surface, raw);
  });
  return (selected.length > 0 ? selected : arr.slice(0, fallbackLimit)).slice(0, fallbackLimit);
}

function filterContext(context, surface) {
  const c = deepCloneJson(context || {}) || {};
  c.routes = filterEntries(c.routes, surface, 20);
  c.pages = filterEntries(c.pages, surface, 20);
  c.apiEndpoints = filterEntries(c.apiEndpoints || c.endpoints, surface, 30);
  c.endpoints = filterEntries(c.endpoints || c.apiEndpoints, surface, 30);
  c.forms = filterEntries(c.forms, surface, 20);
  if (c.files && Array.isArray(c.files)) {
    c.files = c.files
      .filter((file) => {
        const p = typeof file === 'string' ? file : file?.path || file?.filePath;
        return p && !isArtifactFile(p) && (matchesSurfaceText(surface, p) || asArray(surface?.sourceFiles).includes(p));
      })
      .slice(0, 40);
  }
  c.surfaceFocus = surface;
  return c;
}

function filterExploration(explorationArtifact, surface) {
  const e = deepCloneJson(explorationArtifact || {}) || null;
  if (!e) return e;
  for (const key of ['routes', 'pages', 'forms', 'assertableText', 'anchors', 'interactions']) {
    if (Array.isArray(e[key])) e[key] = filterEntries(e[key], surface, 30);
  }
  return e;
}

function filterCorpus(corpusSeed, surface) {
  if (!corpusSeed) return corpusSeed;
  const seed = deepCloneJson(corpusSeed) || {};
  if (Array.isArray(seed.persistedTests)) {
    seed.persistedTests = seed.persistedTests
      .filter((t) => matchesSurfaceText(surface, `${t.title || ''} ${t.filePath || ''} ${(t.tags || []).join(' ')}`))
      .slice(0, 20);
  }
  if (Array.isArray(seed.contractSnapshots)) {
    seed.contractSnapshots = seed.contractSnapshots
      .filter((s) => matchesSurfaceText(surface, JSON.stringify(s)))
      .slice(0, 30);
  }
  return seed;
}

function pruneUntilBudget(payload, budget) {
  const meta = {
    tokenBudget: budget,
    estimatedTokens: estimateTokens(payload),
    truncated: false,
    droppedCounts: {},
  };
  if (meta.estimatedTokens <= budget) return { payload, meta };

  const shrink = (obj, pathKey, nextLength) => {
    const parts = pathKey.split('.');
    let node = obj;
    for (const part of parts.slice(0, -1)) node = node?.[part];
    const key = parts[parts.length - 1];
    if (!Array.isArray(node?.[key])) return false;
    const before = node[key].length;
    node[key] = node[key].slice(0, Math.max(0, nextLength));
    meta.droppedCounts[pathKey] = (meta.droppedCounts[pathKey] || 0) + Math.max(0, before - node[key].length);
    return true;
  };

  const order = [
    ['explorationArtifact.assertableText', 10],
    ['explorationArtifact.anchors', 10],
    ['context.files', 10],
    ['corpusSeed.persistedTests', 8],
    ['context.routes', 8],
    ['context.pages', 8],
    ['context.apiEndpoints', 12],
    ['context.endpoints', 12],
  ];
  for (const [key, len] of order) {
    if (estimateTokens(payload) <= budget) break;
    shrink(payload, key, len);
  }

  if (estimateTokens(payload) > budget && typeof payload.feedback === 'string') {
    const maxChars = Math.max(1000, budget * CHARS_PER_TOKEN - estimateTokens({ ...payload, feedback: '' }) * CHARS_PER_TOKEN);
    if (payload.feedback.length > maxChars) {
      payload.feedback = `${payload.feedback.slice(0, maxChars)}\n\n[feedback truncated by Healix context packer]`;
      meta.droppedCounts.feedbackChars = payload.feedback.length - maxChars;
    }
  }

  meta.estimatedTokens = estimateTokens(payload);
  meta.truncated = meta.estimatedTokens > budget || Object.keys(meta.droppedCounts).length > 0;
  return { payload, meta };
}

function readSourcePreviews(projectPath, surface, maxFiles = 8) {
  const previews = [];
  for (const relOrAbs of asArray(surface?.sourceFiles).slice(0, maxFiles)) {
    if (!relOrAbs || isArtifactFile(relOrAbs)) continue;
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(projectPath || '', relOrAbs);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const text = fs.readFileSync(abs, 'utf8');
      previews.push({
        filePath: relOrAbs,
        preview: text.slice(0, 12_000),
        truncated: text.length > 12_000,
      });
    } catch {
      // non-blocking; source files are additive context
    }
  }
  return previews;
}

function packContextForSurface({
  context,
  parsedPRD,
  explorationArtifact,
  corpusSeed,
  corpusGuidance,
  feedback,
  topupFocus,
  surface,
  projectPath,
  tokenBudget: explicitBudget,
} = {}) {
  const budget = Number.isFinite(explicitBudget) && explicitBudget > 0 ? explicitBudget : tokenBudget();
  const focus = surface || { surfaceKey: 'root', label: 'Root QA generation', routes: [], apiEndpoints: [], forms: [], roles: [], sourceFiles: [] };
  const packed = {
    context: filterContext(context, focus),
    parsedPRD: deepCloneJson(parsedPRD),
    explorationArtifact: filterExploration(explorationArtifact, focus),
    corpusSeed: filterCorpus(corpusSeed, focus),
    corpusGuidance,
    feedback,
    topupFocus: topupFocus ? { ...deepCloneJson(topupFocus), selectedSurface: focus } : null,
    surfaceFocus: focus,
    sourcePreviews: readSourcePreviews(projectPath, focus),
  };
  const { payload, meta } = pruneUntilBudget(packed, budget);
  return {
    ...payload,
    promptBudget: meta,
  };
}

module.exports = {
  packContextForSurface,
  estimateTokens,
  tokenBudget,
  _internals: { filterContext, filterExploration, filterCorpus, pruneUntilBudget, readSourcePreviews },
};
