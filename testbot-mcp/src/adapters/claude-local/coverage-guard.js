'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
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
    for (const key of ['tag', 'id', 'acId', 'acceptanceCriteriaId', 'reqId', 'requirementId']) {
      if (typeof node[key] === 'string') visit(node[key]);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(parsedPRD);
  return [...out];
}

function hasArtifactFile(contextArtifacts, name) {
  const files = contextArtifacts?.files || contextArtifacts?.relativeFiles || {};
  return Boolean(files && files[name]);
}

function evaluateCoverageGuard({
  parsedPRD,
  compactSummary,
  contextArtifacts,
  omitLoadedContext,
  planValidation = null,
} = {}) {
  const expectedAcIds = [
    ...new Set([
      ...collectAcIds(parsedPRD),
      ...asArray(compactSummary?.surface?.acIds),
    ]),
  ];
  const selectedSurfaces = {
    routes: asArray(compactSummary?.surface?.routes),
    apiEndpoints: asArray(compactSummary?.surface?.apiEndpoints),
    forms: asArray(compactSummary?.surface?.forms),
    roles: asArray(compactSummary?.surface?.roles),
  };
  const manifestCoverage = {
    acceptanceCriteria: expectedAcIds.length === 0 || hasArtifactFile(contextArtifacts, 'acceptance-criteria.csv'),
    routes: selectedSurfaces.routes.length === 0 || hasArtifactFile(contextArtifacts, 'routes.csv'),
    api: selectedSurfaces.apiEndpoints.length === 0 || hasArtifactFile(contextArtifacts, 'api.csv'),
    forms: selectedSurfaces.forms.length === 0 || hasArtifactFile(contextArtifacts, 'forms.csv'),
    roles: selectedSurfaces.roles.length === 0 || hasArtifactFile(contextArtifacts, 'roles.csv'),
  };
  const missingManifest = Object.entries(manifestCoverage)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  const plannedAcIds = asArray(planValidation?.plannedAcIds);
  const missingPlannedAcIds = expectedAcIds.length > 0 && plannedAcIds.length > 0
    ? expectedAcIds.filter((id) => !plannedAcIds.includes(id))
    : [];
  const coverageRisk = missingManifest.length > 0
    || (planValidation?.warnings || []).some((w) => /no_ac_ids_planned|missing_expected_ac_ids/.test(String(w)));
  return {
    expectedAcIds,
    plannedAcIds,
    selectedSurfaces,
    criticalSurfaceCoverage: manifestCoverage,
    missingManifest,
    missingPlannedAcIds,
    coverageRisk,
    recommendExpandedContext: Boolean(omitLoadedContext && missingManifest.length > 0),
    expandedContextUsed: false,
  };
}

function renderCoverageGuard(guard) {
  if (!guard) return '';
  const lines = [
    `coverageRisk: ${guard.coverageRisk ? 'yes' : 'no'}`,
    `expectedAcIds: ${asArray(guard.expectedAcIds).slice(0, 80).join(', ') || '(none)'}`,
    `selectedRoutes: ${asArray(guard.selectedSurfaces?.routes).slice(0, 30).join(', ') || '(none)'}`,
    `selectedApiEndpoints: ${asArray(guard.selectedSurfaces?.apiEndpoints).slice(0, 30).join(', ') || '(none)'}`,
    `selectedForms: ${asArray(guard.selectedSurfaces?.forms).slice(0, 30).join(', ') || '(none)'}`,
  ];
  if (asArray(guard.missingManifest).length) lines.push(`missingContextArtifacts: ${guard.missingManifest.join(', ')}`);
  if (asArray(guard.missingPlannedAcIds).length) lines.push(`missingPlannedAcIds: ${guard.missingPlannedAcIds.slice(0, 30).join(', ')}`);
  if (guard.coverageRisk) {
    lines.push('Do not reduce scope to save tokens. If context is insufficient, ask a question or write a coverage question instead of silently skipping.');
  }
  return lines.join('\n');
}

module.exports = {
  collectAcIds,
  evaluateCoverageGuard,
  renderCoverageGuard,
};
