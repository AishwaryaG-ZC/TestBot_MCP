'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isArtifactFile } = require('./surface-inventory');

const DEFAULT_TOKEN_BUDGET = 120_000;
const CHARS_PER_TOKEN = 4;

function externalContextEnabled() {
  return process.env.HEALIX_CLAUDE_EXTERNAL_CONTEXT !== 'false';
}

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

function scrubBugTokens(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\bBUG-[A-Z][A-Z0-9]*\b/g, '[redacted]');
}

function redactString(value) {
  if (typeof value !== 'string') return value;
  return scrubBugTokens(value)
    .replace(/\b(?:sk|pk|rk|re|bu)_(?:test|live|proj)?[_A-Za-z0-9-]{16,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(password|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*['"]?[^'",\n\s]+/gi, '$1=[REDACTED]');
}

function sanitizeValue(value, key = '') {
  const lowerKey = String(key || '').toLowerCase();
  if (/(password|secret|token|cookie|authorization|apikey|api_key|service_role|credentials?)/.test(lowerKey)) {
    if (!/(storage|path|file)/.test(lowerKey)) return '[REDACTED]';
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) out[childKey] = sanitizeValue(childValue, childKey);
    return out;
  }
  return value;
}

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows || []) {
    lines.push(headers.map((header) => csvEscape(row?.[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function safeSurfaceKey(value) {
  return String(value || 'root').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'root';
}

function rel(projectPath, abs) {
  try { return path.relative(projectPath, abs) || path.basename(abs); } catch { return abs; }
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
      const before = payload.feedback.length;
      payload.feedback = `${payload.feedback.slice(0, maxChars)}\n\n[feedback truncated by Healix context packer]`;
      meta.droppedCounts.feedbackChars = Math.max(0, before - maxChars);
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

function acceptanceCriteriaRows(parsedPRD) {
  const rows = [];
  const features = Array.isArray(parsedPRD?.features) ? parsedPRD.features : [];
  features.forEach((feature, fIdx) => {
    const stories = Array.isArray(feature?.userStories) ? feature.userStories : [];
    stories.forEach((story, sIdx) => {
      const acs = Array.isArray(story?.acceptanceCriteria) ? story.acceptanceCriteria : [];
      acs.forEach((ac, aIdx) => {
        const rawTag = typeof ac === 'object' ? (ac.tag || ac.id || '') : '';
        const tag = rawTag || `F${fIdx + 1}.S${sIdx + 1}.AC${aIdx + 1}`;
        const text = typeof ac === 'string' ? ac : (ac?.text || ac?.criterion || ac?.description || '');
        rows.push({
          id: tag,
          feature: feature?.id || feature?.name || `F${fIdx + 1}`,
          story: story?.id || story?.title || `S${sIdx + 1}`,
          text: redactString(text),
        });
      });
    });
  });
  return rows;
}

// G45: normalize a heading/button entry to a clean visible-text string so
// routes.csv doesn't get filled with `[object Object]` or raw JSX expressions
// (e.g. `setSelectedSize(size)} className="..."`). Anything that doesn't
// collapse to a sensible label is dropped — Claude shouldn't see code as
// "context" pretending to be UI text.
function normalizeUiLabel(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') {
    // Strip raw JSX expression bleed: lines containing `} className=`,
    // `setX(...)`, callback-arrow `=>`, and other code tokens.
    if (/[{}<>]|=>|className=|onClick=|\bconst\b|\blet\b/.test(entry)) return '';
    return entry.trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  if (typeof entry === 'object') {
    const label = entry.text || entry.label || entry.name || entry.title || entry.accessibleName;
    return typeof label === 'string' ? normalizeUiLabel(label) : '';
  }
  return '';
}

function routeRows(explorationArtifact, context) {
  const routes = [
    ...asArray(explorationArtifact?.routes),
    ...asArray(explorationArtifact?.pages),
    ...asArray(context?.routes),
    ...asArray(context?.pages),
  ];
  return routes.slice(0, 200).map((route) => {
    const raw = typeof route === 'string' ? { path: route } : route || {};
    return {
      path: raw.path || raw.route || raw.url || '',
      auth: raw.requiresAuth === true ? 'auth' : raw.requiresAuth === false ? 'public' : '',
      sourceFile: raw.sourceFile || raw.filePath || '',
      headings: asArray(raw.headings).slice(0, 5).map(normalizeUiLabel).filter(Boolean).join(' | '),
      buttons: asArray(raw.buttons).slice(0, 6).map(normalizeUiLabel).filter(Boolean).join(' | '),
    };
  });
}

function apiRows(explorationArtifact, context) {
  const endpoints = [
    ...asArray(explorationArtifact?.apiEndpoints),
    ...asArray(context?.apiEndpoints),
    ...asArray(context?.endpoints),
  ];
  return endpoints.slice(0, 240).map((endpoint) => {
    const raw = typeof endpoint === 'string' ? { endpoint } : endpoint || {};
    return {
      method: String(raw.method || raw.httpMethod || raw.verb || '').toUpperCase(),
      path: raw.path || raw.endpoint || raw.route || raw.url || '',
      auth: raw.requiresAuth === true ? 'auth' : raw.requiresAuth === false ? 'public' : '',
      status: raw.status || raw.expectedStatus || '',
      sourceFile: raw.sourceFile || raw.filePath || '',
      // G50: optional fields populated from exploration's response harvester.
      // Truncated upstream; safe to embed in CSV (we URI-encode in toCsv).
      responseShape: typeof raw.responseShape === 'string' ? raw.responseShape.slice(0, 600) : '',
      sampleResponse: typeof raw.sampleResponse === 'string' ? raw.sampleResponse.slice(0, 1200) : '',
    };
  });
}

function formRows(explorationArtifact, context) {
  const forms = [
    ...asArray(explorationArtifact?.forms),
    ...asArray(context?.forms),
    ...asArray(context?.ui?.forms),
  ];
  return forms.slice(0, 120).map((form) => {
    const fields = asArray(form?.fields)
      .slice(0, 20)
      .map((field) => `${field.name || '?'}:${field.type || '?'}${field.required ? '*' : ''}`)
      .join('|');
    return {
      name: form?.name || form?.id || form?.action || form?.file || 'form',
      route: form?.route || form?.path || '',
      method: form?.method || 'POST',
      fields,
      sourceFile: form?.sourceFile || form?.filePath || form?.file || '',
    };
  });
}

function roleRows(roles) {
  return asArray(roles).map((role) => ({
    role: role?.role || role?.name || String(role || 'user'),
    verified: role?.verified || role?.loginVerified ? 'yes' : 'no',
    storageStatePath: role?.storageStatePath || role?.storageState || '',
  }));
}

function writeContextArtifacts({
  projectPath,
  runId,
  surface,
  context,
  parsedPRD,
  prdContent,
  explorationArtifact,
  roles,
  corpusSeed,
  corpusGuidance,
  feedback,
  sourcePreviews,
} = {}) {
  if (!externalContextEnabled() || !projectPath) return null;
  const surfaceKey = safeSurfaceKey(surface?.surfaceKey || 'root');
  const root = path.join(projectPath, '.healix', 'context', safeSurfaceKey(runId || 'local'), surfaceKey);
  fs.mkdirSync(root, { recursive: true });
  const files = {};
  const write = (name, body) => {
    const filePath = path.join(root, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);
    files[name] = filePath;
  };

  write('prd.md', `${redactString(prdContent || '')}\n`);
  write('acceptance-criteria.csv', toCsv(acceptanceCriteriaRows(parsedPRD), ['id', 'feature', 'story', 'text']));
  write('routes.csv', toCsv(routeRows(explorationArtifact, context), ['path', 'auth', 'sourceFile', 'headings', 'buttons']));
  // G50: api.csv now includes `responseShape` (compact path:type sketch) and
  // a truncated `sampleResponse` JSON string when exploration captured one.
  // This is what makes nested-property assertions correct: Claude can see
  // `user.email:string` instead of guessing `email`.
  write('api.csv', toCsv(apiRows(explorationArtifact, context), ['method', 'path', 'auth', 'status', 'sourceFile', 'responseShape', 'sampleResponse']));
  write('forms.csv', toCsv(formRows(explorationArtifact, context), ['name', 'route', 'method', 'fields', 'sourceFile']));
  write('roles.csv', toCsv(roleRows(roles), ['role', 'verified', 'storageStatePath']));
  write('corpus.json', `${JSON.stringify(sanitizeValue({ corpusSeed, corpusGuidance }), null, 2)}\n`);
  write('feedback.md', `${redactString(typeof feedback === 'string' ? feedback : JSON.stringify(feedback || '', null, 2))}\n`);

  const previewDir = path.join(root, 'source-previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const previewFiles = [];
  for (const preview of asArray(sourcePreviews)) {
    const name = `${previewFiles.length + 1}-${path.basename(String(preview.filePath || 'source')).replace(/[^a-zA-Z0-9_.-]+/g, '_')}.txt`;
    const filePath = path.join(previewDir, name);
    fs.writeFileSync(filePath, redactString(preview.preview || ''));
    previewFiles.push({ sourceFile: preview.filePath, path: filePath, truncated: Boolean(preview.truncated) });
  }

  const manifest = {
    root,
    surfaceKey: surface?.surfaceKey || 'root',
    files: Object.fromEntries(Object.entries(files).map(([name, filePath]) => [name, filePath])),
    sourcePreviews: previewFiles,
    bytes: [...Object.values(files), ...previewFiles.map((p) => p.path)]
      .reduce((sum, filePath) => {
        try { return sum + fs.statSync(filePath).size; } catch { return sum; }
      }, 0),
  };
  write('manifest.json', `${JSON.stringify(sanitizeValue(manifest), null, 2)}\n`);
  manifest.files['manifest.json'] = path.join(root, 'manifest.json');
  manifest.relativeFiles = Object.fromEntries(Object.entries(manifest.files).map(([name, filePath]) => [name, rel(projectPath, filePath)]));
  return manifest;
}

function compactContextSummary({ context, parsedPRD, explorationArtifact, roles, corpusSeed, corpusGuidance, surface } = {}) {
  return {
    surface: {
      surfaceKey: surface?.surfaceKey || 'root',
      label: surface?.label || surface?.surfaceKey || 'Root',
      type: surface?.type || 'misc',
      routes: asArray(surface?.routes).slice(0, 12),
      apiEndpoints: asArray(surface?.apiEndpoints).slice(0, 12),
      forms: asArray(surface?.forms).slice(0, 12),
      roles: asArray(surface?.roles).slice(0, 12),
      acIds: asArray(surface?.acIds).slice(0, 30),
    },
    counts: {
      acceptanceCriteria: acceptanceCriteriaRows(parsedPRD).length,
      routes: routeRows(explorationArtifact, context).length,
      apiEndpoints: apiRows(explorationArtifact, context).length,
      forms: formRows(explorationArtifact, context).length,
      roles: asArray(roles).length,
      persistedTests: asArray(corpusSeed?.persistedTests).length,
      doNotRegenerate: asArray(corpusGuidance?.doNotRegenerate).length,
      prioritizeUncovered: asArray(corpusGuidance?.prioritizeUncovered).length,
    },
  };
}

function packContextForSurface({
  context,
  prdContent,
  parsedPRD,
  explorationArtifact,
  roles,
  corpusSeed,
  corpusGuidance,
  feedback,
  topupFocus,
  surface,
  projectPath,
  runId,
  tokenBudget: explicitBudget,
} = {}) {
  const budget = Number.isFinite(explicitBudget) && explicitBudget > 0 ? explicitBudget : tokenBudget();
  const focus = surface || { surfaceKey: 'root', label: 'Root QA generation', routes: [], apiEndpoints: [], forms: [], roles: [], sourceFiles: [] };
  const sourcePreviews = readSourcePreviews(projectPath, focus);
  const contextArtifacts = writeContextArtifacts({
    projectPath,
    runId,
    surface: focus,
    context,
    parsedPRD,
    prdContent,
    explorationArtifact,
    roles,
    corpusSeed,
    corpusGuidance,
    feedback,
    sourcePreviews,
  });
  const compactSummary = compactContextSummary({ context, parsedPRD, explorationArtifact, roles, corpusSeed, corpusGuidance, surface: focus });
  const packed = {
    context: filterContext(context, focus),
    parsedPRD: deepCloneJson(parsedPRD),
    explorationArtifact: filterExploration(explorationArtifact, focus),
    corpusSeed: filterCorpus(corpusSeed, focus),
    corpusGuidance,
    feedback,
    topupFocus: topupFocus ? { ...deepCloneJson(topupFocus), selectedSurface: focus } : null,
    surfaceFocus: focus,
    sourcePreviews,
    contextArtifacts,
    compactSummary,
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
  writeContextArtifacts,
  sanitizeValue,
  redactString,
  externalContextEnabled,
  _internals: {
    filterContext,
    filterExploration,
    filterCorpus,
    pruneUntilBudget,
    readSourcePreviews,
    acceptanceCriteriaRows,
    routeRows,
    apiRows,
    formRows,
    roleRows,
    compactContextSummary,
    safeSurfaceKey,
  },
};
