'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_MAX_SHARDS = 8;
const DEFAULT_FANOUT_TOKEN_THRESHOLD = 60_000;

function sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function normalizeRoute(value) {
  if (!value || typeof value !== 'string') return null;
  let route = value.trim();
  if (!route) return null;
  try {
    if (/^https?:\/\//i.test(route)) route = new URL(route).pathname;
  } catch {
    // keep raw route
  }
  route = route.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!route.startsWith('/')) route = `/${route}`;
  route = route.replace(/\[(\.\.\.)?([^\]]+)\]/g, ':$2');
  route = route.replace(/\/:[^/]+/g, (m) => m.toLowerCase());
  return route === '/' ? '/' : route.replace(/\/$/, '');
}

function normalizeEndpoint(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const m = entry.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
    if (!m) return null;
    return { method: m[1].toUpperCase(), path: normalizeRoute(m[2]) };
  }
  if (typeof entry !== 'object') return null;
  const method = String(entry.method || entry.httpMethod || entry.verb || '').toUpperCase();
  const rawPath = entry.path || entry.route || entry.url || entry.endpoint;
  const route = normalizeRoute(String(rawPath || ''));
  if (!method || !route) return null;
  return { method, path: route, sourceFile: entry.sourceFile || entry.filePath || null, raw: entry };
}

function isArtifactFile(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return (
    p.includes('/node_modules/') ||
    p.includes('/.next/') ||
    p.includes('/dist/') ||
    p.includes('/build/') ||
    p.includes('/coverage/') ||
    p.includes('/public/') && /chunk-[a-z0-9]+\.js$/.test(p) ||
    p.endsWith('.min.js') ||
    p.endsWith('.d.ts') ||
    p.endsWith('.map')
  );
}

function sourceFilesFrom(value) {
  const out = new Set();
  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      if (!isArtifactFile(node) && /[/.][A-Za-z0-9_-]+\.(tsx?|jsx?|java|kt|go|py|rb|php|cs)$/.test(node)) out.add(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    for (const key of ['file', 'filePath', 'sourceFile', 'path', 'sourcePath']) {
      if (typeof node[key] === 'string') visit(node[key]);
    }
    for (const key of ['sourceFiles', 'files', 'sources']) visit(node[key]);
  };
  visit(value);
  return [...out].slice(0, 40);
}

function collectAcIds(parsedPRD) {
  const out = new Set();
  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      for (const m of node.matchAll(/\b(?:F\d+\.)?S\d+\.AC\d+\b|\bAC[-_:]?[A-Za-z0-9_.-]+\b/g)) out.add(m[0]);
      return;
    }
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    for (const key of ['id', 'acId', 'acceptanceCriteriaId', 'reqId', 'requirementId']) {
      if (typeof node[key] === 'string') visit(node[key]);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(parsedPRD);
  return [...out].slice(0, 200);
}

function addSurface(map, surface) {
  if (!surface?.surfaceKey) return;
  const existing = map.get(surface.surfaceKey);
  if (!existing) {
    map.set(surface.surfaceKey, {
      surfaceKey: surface.surfaceKey,
      type: surface.type || 'misc',
      label: surface.label || surface.surfaceKey,
      routes: new Set(surface.routes || []),
      apiEndpoints: new Set(surface.apiEndpoints || []),
      forms: new Set(surface.forms || []),
      roles: new Set(surface.roles || []),
      acIds: new Set(surface.acIds || []),
      sourceFiles: new Set((surface.sourceFiles || []).filter((f) => !isArtifactFile(f))),
      changed: Boolean(surface.changed),
      lowConfidence: Boolean(surface.lowConfidence),
      examples: [],
    });
    if (surface.example) map.get(surface.surfaceKey).examples.push(surface.example);
    return;
  }
  for (const field of ['routes', 'apiEndpoints', 'forms', 'roles', 'acIds', 'sourceFiles']) {
    for (const value of surface[field] || []) existing[field].add(value);
  }
  existing.changed = existing.changed || Boolean(surface.changed);
  existing.lowConfidence = existing.lowConfidence || Boolean(surface.lowConfidence);
  if (surface.example) existing.examples.push(surface.example);
}

function routeFromFile(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const appIdx = p.lastIndexOf('/app/');
  if (appIdx >= 0) {
    const rel = p.slice(appIdx + 5).replace(/\/(page|route)\.(tsx?|jsx?)$/, '');
    if (rel && rel !== p) return normalizeRoute(rel.replace(/\([^)]*\)\//g, ''));
  }
  return null;
}

function buildSurfaceInventory({
  context = {},
  parsedPRD = null,
  explorationArtifact = null,
  roles = [],
  corpusSeed = null,
  topupFocus = null,
  sourceFingerprints = null,
  maxShards = null,
} = {}) {
  const max = Number.isFinite(maxShards)
    ? maxShards
    : (Number.parseInt(process.env.HEALIX_CLAUDE_MAX_SHARDS || '', 10) || DEFAULT_MAX_SHARDS);
  const surfaces = new Map();
  const acIds = collectAcIds(parsedPRD);
  const allSourceFiles = sourceFilesFrom(context);

  const apiCandidates = [
    ...(Array.isArray(context.apiEndpoints) ? context.apiEndpoints : []),
    ...(Array.isArray(context.endpoints) ? context.endpoints : []),
    ...(Array.isArray(context.routesApi) ? context.routesApi : []),
    ...(Array.isArray(context?.api?.endpoints) ? context.api.endpoints : []),
  ];
  for (const entry of apiCandidates) {
    const endpoint = normalizeEndpoint(entry);
    if (!endpoint) continue;
    const key = `api:${endpoint.method} ${endpoint.path}`;
    const sourceFiles = sourceFilesFrom(entry);
    addSurface(surfaces, {
      surfaceKey: key,
      type: 'api',
      label: `${endpoint.method} ${endpoint.path}`,
      apiEndpoints: [`${endpoint.method} ${endpoint.path}`],
      routes: [endpoint.path],
      acIds,
      sourceFiles: sourceFiles.length > 0 ? sourceFiles : allSourceFiles,
      lowConfidence: sourceFiles.length === 0,
      example: entry,
    });
  }

  const routeCandidates = [
    ...(Array.isArray(context.routes) ? context.routes : []),
    ...(Array.isArray(context.pages) ? context.pages : []),
    ...(Array.isArray(explorationArtifact?.routes) ? explorationArtifact.routes : []),
    ...(Array.isArray(explorationArtifact?.pages) ? explorationArtifact.pages : []),
  ];
  for (const entry of routeCandidates) {
    const raw = typeof entry === 'string' ? entry : (entry?.path || entry?.url || entry?.route);
    const route = normalizeRoute(String(raw || ''));
    if (!route) continue;
    const sourceFiles = sourceFilesFrom(entry);
    addSurface(surfaces, {
      surfaceKey: `ui:${route}`,
      type: 'ui',
      label: route,
      routes: [route],
      acIds,
      sourceFiles: sourceFiles.length > 0 ? sourceFiles : allSourceFiles,
      lowConfidence: sourceFiles.length === 0 && !String(raw || '').startsWith('/'),
      example: entry,
    });
  }

  const formCandidates = [
    ...(Array.isArray(context.forms) ? context.forms : []),
    ...(Array.isArray(context?.ui?.forms) ? context.ui.forms : []),
    ...(Array.isArray(explorationArtifact?.forms) ? explorationArtifact.forms : []),
  ];
  for (const form of formCandidates) {
    const name = String(form?.name || form?.id || form?.route || form?.action || 'form').trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'form';
    const route = normalizeRoute(String(form?.route || form?.path || '')) || null;
    addSurface(surfaces, {
      surfaceKey: `form:${slug}`,
      type: 'form',
      label: name,
      routes: route ? [route] : [],
      forms: [name],
      acIds,
      sourceFiles: sourceFilesFrom(form),
      example: form,
    });
  }

  for (const role of roles || []) {
    const name = typeof role === 'string' ? role : (role?.role || role?.name);
    if (!name) continue;
    addSurface(surfaces, {
      surfaceKey: `rbac:${String(name).toLowerCase()}`,
      type: 'rbac',
      label: `RBAC ${name}`,
      roles: [String(name)],
      acIds,
      sourceFiles: allSourceFiles,
    });
  }

  const focusFiles = [
    ...(Array.isArray(topupFocus?.changedFiles) ? topupFocus.changedFiles : []),
    ...(Array.isArray(topupFocus?.newFiles) ? topupFocus.newFiles : []),
  ];
  for (const f of focusFiles) {
    const filePath = typeof f === 'string' ? f : f?.filePath;
    if (!filePath || isArtifactFile(filePath)) continue;
    const route = routeFromFile(filePath);
    if (route) {
      const type = /\/route\.(tsx?|jsx?)$/.test(String(filePath)) ? 'api' : 'ui';
      addSurface(surfaces, {
        surfaceKey: `${type}:${route}`,
        type,
        label: route,
        routes: [route],
        acIds,
        sourceFiles: [filePath],
        changed: true,
      });
    } else {
      addSurface(surfaces, {
        surfaceKey: `source:${path.basename(filePath)}`,
        type: 'misc',
        label: filePath,
        acIds,
        sourceFiles: [filePath],
        changed: true,
      });
    }
  }

  for (const fp of sourceFingerprints || []) {
    if (!fp?.filePath || isArtifactFile(fp.filePath)) continue;
    const route = routeFromFile(fp.filePath);
    if (!route) continue;
    const type = String(fp.fileKind || '').includes('api') || /\/route\./.test(fp.filePath) ? 'api' : 'ui';
    addSurface(surfaces, {
      surfaceKey: `${type}:${route}`,
      type,
      label: route,
      routes: [route],
      acIds,
      sourceFiles: [fp.filePath],
    });
  }

  if (surfaces.size === 0) {
    addSurface(surfaces, {
      surfaceKey: 'misc-public',
      type: 'misc',
      label: 'Misc public coverage',
      acIds,
      sourceFiles: allSourceFiles,
      lowConfidence: true,
    });
  }

  let list = [...surfaces.values()].map((s) => {
    const obj = {
      surfaceKey: s.surfaceKey,
      type: s.type,
      label: s.label,
      routes: [...s.routes].sort(),
      apiEndpoints: [...s.apiEndpoints].sort(),
      forms: [...s.forms].sort(),
      roles: [...s.roles].sort(),
      acIds: [...s.acIds].sort(),
      sourceFiles: [...s.sourceFiles].sort(),
      changed: s.changed,
      lowConfidence: s.lowConfidence,
      examples: s.examples.slice(0, 3),
    };
    obj.fingerprintHash = sha(stableJson({
      surfaceKey: obj.surfaceKey,
      routes: obj.routes,
      apiEndpoints: obj.apiEndpoints,
      forms: obj.forms,
      roles: obj.roles,
      acIds: obj.acIds,
      sourceFiles: obj.sourceFiles,
    }));
    return obj;
  });

  list.sort((a, b) => Number(b.changed) - Number(a.changed) || priority(a.type) - priority(b.type) || a.surfaceKey.localeCompare(b.surfaceKey));
  if (list.length > max) {
    const keep = list.slice(0, max - 1);
    const rest = list.slice(max - 1);
    const misc = {
      surfaceKey: 'misc-merged',
      type: 'misc',
      label: 'Merged lower-risk surfaces',
      routes: [...new Set(rest.flatMap((s) => s.routes))].sort(),
      apiEndpoints: [...new Set(rest.flatMap((s) => s.apiEndpoints))].sort(),
      forms: [...new Set(rest.flatMap((s) => s.forms))].sort(),
      roles: [...new Set(rest.flatMap((s) => s.roles))].sort(),
      acIds: [...new Set(rest.flatMap((s) => s.acIds))].sort(),
      sourceFiles: [...new Set(rest.flatMap((s) => s.sourceFiles))].sort(),
      changed: rest.some((s) => s.changed),
      lowConfidence: rest.some((s) => s.lowConfidence),
      examples: [],
    };
    misc.fingerprintHash = sha(stableJson(misc));
    list = [...keep, misc];
  }

  const selectedSurfaces = list.filter((s) => s.changed);
  return {
    surfaces: list,
    selectedSurfaces: selectedSurfaces.length > 0 ? selectedSurfaces : list.slice(0, Math.min(list.length, max)),
    summary: {
      totalSurfaces: list.length,
      changedSurfaces: selectedSurfaces.length,
      maxShards: max,
      acIds: acIds.length,
      corpusSeedTests: Array.isArray(corpusSeed?.persistedTests) ? corpusSeed.persistedTests.length : 0,
    },
  };
}

function priority(type) {
  if (type === 'api') return 0;
  if (type === 'form') return 1;
  if (type === 'rbac') return 2;
  if (type === 'ui') return 3;
  return 4;
}

function specialistRoleForSurface(surface) {
  if (surface?.type === 'api') return 'api-contract';
  if (surface?.type === 'rbac') return 'rbac-auth';
  if (surface?.type === 'form') return 'workflow-uat';
  if (surface?.type === 'ui') return 'ui-a11y';
  return 'workflow-uat';
}

function planClaudeFanout({
  surfaceInventory,
  primaryPromptTokens = 0,
  mode = process.env.HEALIX_CLAUDE_FANOUT_MODE || 'auto',
  tokenThreshold = DEFAULT_FANOUT_TOKEN_THRESHOLD,
} = {}) {
  const selected = Array.isArray(surfaceInventory?.selectedSurfaces) && surfaceInventory.selectedSurfaces.length
    ? surfaceInventory.selectedSurfaces
    : Array.isArray(surfaceInventory?.surfaces) ? surfaceInventory.surfaces : [];
  if (!selected.length) {
    return { fanout: false, reason: 'no_surfaces', surfaces: [{ surfaceKey: 'root', specialistRole: 'workflow-uat' }] };
  }
  const normalizedMode = String(mode || 'auto').toLowerCase();
  if (normalizedMode === 'off') {
    return { fanout: false, reason: 'disabled', surfaces: [{ ...selected[0], specialistRole: specialistRoleForSurface(selected[0]) }] };
  }
  const shouldFanout = normalizedMode === 'always'
    || selected.length > 3
    || Number(primaryPromptTokens || 0) > tokenThreshold;
  const chosen = shouldFanout ? selected : selected.slice(0, 1);
  return {
    fanout: shouldFanout,
    reason: shouldFanout
      ? (selected.length > 3 ? 'surface_count' : Number(primaryPromptTokens || 0) > tokenThreshold ? 'token_budget' : 'forced')
      : 'single_surface',
    tokenThreshold,
    primaryPromptTokens,
    surfaces: chosen.map((surface) => ({
      ...surface,
      specialistRole: specialistRoleForSurface(surface),
    })),
  };
}

module.exports = {
  buildSurfaceInventory,
  planClaudeFanout,
  normalizeRoute,
  normalizeEndpoint,
  isArtifactFile,
  stableJson,
  sha,
  _internals: { collectAcIds, routeFromFile, sourceFilesFrom, specialistRoleForSurface },
};
