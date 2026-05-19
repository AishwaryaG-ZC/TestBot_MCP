/**
 * Report Generator
 * Generates test reports in JSON format for the dashboard
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logger = require('./logger');

class ReportGenerator {
  stripAnsiAndNormalize(value) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return value
        .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.stripAnsiAndNormalize(item));
    }

    if (typeof value === 'object') {
      const normalized = {};
      for (const [key, innerValue] of Object.entries(value)) {
        normalized[key] = this.stripAnsiAndNormalize(innerValue);
      }
      return normalized;
    }

    return value;
  }

  normalizePathForReport(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
  }

  normalizeStatus(status) {
    if (!status) return 'unknown';
    const normalized = String(status).toLowerCase();
    if (normalized === 'expected') return 'passed';
    if (normalized === 'unexpected') return 'failed';
    if (normalized === 'pending') return 'skipped';
    return normalized;
  }

  ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  sanitizeArtifactName(name) {
    return String(name || 'artifact')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 180) || 'artifact';
  }

  createArtifactFilename(type, sourcePath, artifactName) {
    const digest = crypto.createHash('sha1').update(sourcePath).digest('hex').slice(0, 12);
    const ext = path.extname(sourcePath) || path.extname(artifactName) || '';
    const base = this.sanitizeArtifactName(path.basename(artifactName || sourcePath, ext));
    return `${type}-${digest}-${base}${ext}`;
  }

  resolveArtifactSourcePath(sourcePath, projectPath, reportsDir) {
    if (!sourcePath) {
      return null;
    }

    const reportRoot = path.resolve(reportsDir);
    const projectRoot = path.resolve(projectPath);
    const allowlistedRoots = [
      projectRoot,
      path.resolve(projectPath, 'test-results'),
      path.resolve(projectPath, 'playwright-mcp-output'),
      path.resolve(projectPath, 'tests'),
      reportRoot,
    ];

    let candidate = String(sourcePath);
    if (!path.isAbsolute(candidate)) {
      const projectRelative = path.resolve(projectPath, candidate);
      const reportRelative = path.resolve(reportsDir, candidate);
      candidate = fs.existsSync(projectRelative) ? projectRelative : reportRelative;
    }

    const resolved = path.resolve(candidate);
    const inAllowedRoot = allowlistedRoots.some((root) =>
      resolved === root || resolved.startsWith(`${root}${path.sep}`)
    );

    if (!inAllowedRoot) {
      return null;
    }

    return resolved;
  }

  isArtifactTypeAllowed(type, sourcePath) {
    const ext = path.extname(sourcePath).toLowerCase();
    const allowed = {
      screenshots: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
      videos: new Set(['.webm', '.mp4', '.mov', '.mkv']),
      traces: new Set(['.zip', '.trace']),
      other: new Set(['.txt', '.log', '.json', '.har', '.html', '.md']),
    };

    if (!allowed[type]) {
      return false;
    }

    if (allowed[type].has(ext)) {
      return true;
    }

    if (type === 'traces' && sourcePath.toLowerCase().includes('trace')) {
      return true;
    }

    return false;
  }

  copySingleArtifact({ artifact, type, artifactsDir, reportsDir, projectPath, copiedMap, maxBytes }) {
    const sourcePath = artifact.fullPath || artifact.path;
    const resolvedSource = this.resolveArtifactSourcePath(sourcePath, projectPath, reportsDir);

    if (!resolvedSource || !fs.existsSync(resolvedSource)) {
      return null;
    }

    if (!this.isArtifactTypeAllowed(type, resolvedSource)) {
      return null;
    }

    const stats = fs.statSync(resolvedSource);
    if (stats.size > maxBytes) {
      Logger.warn('ReportGenerator', 'Skipping oversized artifact', {
        type,
        file: resolvedSource,
        size: stats.size,
      });
      return null;
    }

    if (copiedMap.has(resolvedSource)) {
      return copiedMap.get(resolvedSource);
    }

    const destDir = path.join(artifactsDir, type);
    this.ensureDir(destDir);

    const filename = this.createArtifactFilename(type, resolvedSource, artifact.name);
    const destination = path.join(destDir, filename);

    const resolvedDest = path.resolve(destination);
    if (!resolvedDest.startsWith(`${path.resolve(artifactsDir)}${path.sep}`)) {
      return null;
    }

    fs.copyFileSync(resolvedSource, resolvedDest);

    const normalized = {
      name: this.stripAnsiAndNormalize(artifact.name || path.basename(resolvedSource)),
      contentType: this.stripAnsiAndNormalize(artifact.contentType || null),
      path: this.normalizePathForReport(path.relative(reportsDir, resolvedDest)),
      fullPath: resolvedDest,
      size: stats.size,
    };

    copiedMap.set(resolvedSource, normalized);
    return normalized;
  }

  normalizeArtifactCollections(collection, context) {
    const normalized = {
      screenshots: [],
      videos: [],
      traces: [],
      other: [],
    };

    for (const type of Object.keys(normalized)) {
      const artifacts = Array.isArray(collection?.[type]) ? collection[type] : [];
      for (const artifact of artifacts) {
        const copied = this.copySingleArtifact({
          artifact: this.stripAnsiAndNormalize(artifact),
          type,
          ...context,
        });

        if (copied) {
          normalized[type].push(copied);
        }
      }
    }

    return normalized;
  }

  async copyArtifacts(testResults, reportsDir, projectPath) {
    const artifactsDir = path.join(reportsDir, 'artifacts');
    this.ensureDir(artifactsDir);

    const copiedMap = new Map();
    const maxBytes = Number(process.env.HEALIX_MAX_ARTIFACT_BYTES || 50 * 1024 * 1024);
    const context = {
      artifactsDir,
      reportsDir,
      projectPath,
      copiedMap,
      maxBytes,
    };

    for (const test of testResults.tests || []) {
      test.artifacts = this.normalizeArtifactCollections(test.artifacts, context);
    }

    for (const failure of testResults.failures || []) {
      failure.artifacts = this.normalizeArtifactCollections(failure.artifacts, context);
    }

    if (testResults.artifacts) {
      testResults.artifacts = this.normalizeArtifactCollections(testResults.artifacts, context);
    }

    return copiedMap.size;
  }

  copyDirectoryRecursive(source, dest) {
    this.ensureDir(dest);
    const items = fs.readdirSync(source);

    for (const item of items) {
      const sourcePath = path.join(source, item);
      const destPath = path.join(dest, item);
      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        this.copyDirectoryRecursive(sourcePath, destPath);
      } else {
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  }

  async copyPlaywrightHTMLReport(projectPath, reportsDir) {
    try {
      const possibleLocations = [
        path.join(projectPath, 'healix-reports', 'html-report'),
        path.join(projectPath, 'healix-report'),
        path.join(projectPath, 'playwright-report'),
        path.join(projectPath, 'test-results', 'playwright-report'),
      ];

      const sourceReportDir = possibleLocations.find((location) =>
        fs.existsSync(path.join(location, 'index.html'))
      );

      if (!sourceReportDir) {
        return;
      }

      const destReportDir = path.join(reportsDir, 'html-report');

      if (path.resolve(sourceReportDir) === path.resolve(destReportDir)) {
        return;
      }

      if (fs.existsSync(destReportDir)) {
        fs.rmSync(destReportDir, { recursive: true, force: true });
      }

      this.copyDirectoryRecursive(sourceReportDir, destReportDir);
    } catch (error) {
      Logger.warn('ReportGenerator', 'Failed to copy Playwright HTML report', { reason: error.message });
    }
  }

  // G57: collapse multiple entries for the same logical test (same file +
  // suite + title) that were artificially inflated by the results-merger's
  // per-project + per-attempt keying. Same test across tierA-public and
  // tierB-auth-admin = ONE canonical row. Best status wins (passed > flaky
  // > skipped > failed). The original entries are retained on
  // `canonical.projectStatuses[]` so per-tier UI drilldown still works.
  //
  // Status precedence rule: if ANY project's final attempt passed, the
  // canonical row is "passed" (a test that works in one tier is generally
  // a working test). "failed" only when EVERY project's final attempt
  // failed. This matches how a human QA would summarize.
  buildCanonicalTestsList(rawTests) {
    if (!Array.isArray(rawTests) || rawTests.length === 0) return [];
    const STATUS_RANK = { passed: 3, flaky: 2, skipped: 1, failed: 0 };
    const canonicalize = (s) => String(s || '').toLowerCase();
    const groups = new Map();
    for (const t of rawTests) {
      const file = String(t.file || '').trim().toLowerCase();
      const suite = String(t.suite || '').trim().toLowerCase();
      const title = String(t.title || '').trim().toLowerCase();
      const key = `${file}::${suite}::${title}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const canonical = [];
    for (const entries of groups.values()) {
      // pick the entry with the highest-ranked status as the canonical row
      let best = entries[0];
      let bestRank = STATUS_RANK[canonicalize(best.status)] ?? -1;
      for (const e of entries) {
        const r = STATUS_RANK[canonicalize(e.status)] ?? -1;
        if (r > bestRank) { best = e; bestRank = r; }
      }
      // attach per-project breakdown
      const projectStatuses = entries.map((e) => ({
        project: e.projectName || e.project || e.browser || 'default',
        status: canonicalize(e.status),
        duration: Number(e.duration || 0),
        retries: Number(e.retries || 0),
      }));
      canonical.push({ ...best, projectStatuses });
    }
    return canonical;
  }

  buildTestsList(testResults, aiAnalysis, jiraData) {
    // G57: dedupe first, then normalize. The raw `testResults.tests` array
    // can have the same logical test repeated per Playwright project; the
    // dashboard's top-line count should reflect unique tests, not Cartesian
    // (project × attempt) entries.
    const rawTests = testResults.tests || [];
    const tests = this.buildCanonicalTestsList(rawTests);

    return tests.map((test) => {
      let errorStr = null;
      let errorDetail = null;

      if (test.error) {
        if (typeof test.error === 'string') {
          errorStr = this.stripAnsiAndNormalize(test.error);
        } else if (typeof test.error === 'object') {
          const callLog = Array.isArray(test.error.callLog)
            ? test.error.callLog
              .map((entry) => this.stripAnsiAndNormalize(entry))
              .filter(Boolean)
              .slice(0, 25)
            : null;

          const message = this.stripAnsiAndNormalize(
            test.error.message || test.error.value || test.error.stack || JSON.stringify(test.error)
          );
          const stack = this.stripAnsiAndNormalize(test.error.stack || null);
          const snippet = this.stripAnsiAndNormalize(test.error.snippet || null);
          const value = this.stripAnsiAndNormalize(test.error.value || null);
          const callLogText = callLog?.length ? `\nCall log:\n${callLog.join('\n')}` : '';

          errorStr = this.stripAnsiAndNormalize([message, stack, value].filter(Boolean).join('\n\n') + callLogText);
          errorDetail = {
            message,
            stack,
            snippet,
            value,
            callLog,
            location: this.stripAnsiAndNormalize(test.error.location || null),
          };
        }
      }

      const normalizedTest = {
        id: this.stripAnsiAndNormalize(test.id || `${test.file}-${test.title}`),
        title: this.stripAnsiAndNormalize(test.title || 'Unnamed test'),
        suite: this.stripAnsiAndNormalize(test.suite || ''),
        file: this.normalizePathForReport(this.stripAnsiAndNormalize(test.file || '')),
        status: this.normalizeStatus(test.status),
        duration: Number(test.duration || 0),
        error: errorStr,
        errorDetail,
        retries: Number(test.retries || 0),
        attachments: {
          screenshots: test.artifacts?.screenshots || [],
          videos: test.artifacts?.videos || [],
          traces: test.artifacts?.traces || [],
          other: test.artifacts?.other || [],
        },
      };

      if (aiAnalysis) {
        const analysis = aiAnalysis.find(
          (item) => item.testName === test.title || item.failure?.testName === test.title
        );

        if (analysis) {
          normalizedTest.aiAnalysis = {
            analysis: this.stripAnsiAndNormalize(analysis.analysis),
            rootCause: this.stripAnsiAndNormalize(analysis.rootCause),
            suggestedFix: this.stripAnsiAndNormalize(analysis.suggestedFix),
            confidence: analysis.confidence,
            affectedFiles: this.stripAnsiAndNormalize(analysis.affectedFiles),
            testingRecommendations: this.stripAnsiAndNormalize(analysis.testingRecommendations),
            aiProvider: 'healix',
            model: analysis.model || 'healix-ai',
          };
        }
      }

      if (jiraData) {
        const jiraMatch = test.file?.match(/([a-z]+)[_-]?(\d+)/i);
        if (jiraMatch) {
          const storyKey = `${jiraMatch[1].toUpperCase()}-${jiraMatch[2]}`;
          const story = jiraData.find((item) => item.key === storyKey);
          if (story) {
            normalizedTest.jiraStory = {
              key: this.stripAnsiAndNormalize(story.key),
              summary: this.stripAnsiAndNormalize(story.summary),
              status: this.stripAnsiAndNormalize(story.status),
              priority: this.stripAnsiAndNormalize(story.priority),
            };
          }
        }
      }

      return normalizedTest;
    });
  }

  buildAISummary(aiAnalysis) {
    const total = aiAnalysis.length;
    const highConfidence = aiAnalysis.filter((item) => item.confidence >= 0.8).length;
    const mediumConfidence = aiAnalysis.filter((item) => item.confidence >= 0.5 && item.confidence < 0.8).length;
    const lowConfidence = aiAnalysis.filter((item) => item.confidence < 0.5).length;

    return {
      total,
      highConfidence,
      mediumConfidence,
      lowConfidence,
      analyses: aiAnalysis.map((item) => ({
        testName: this.stripAnsiAndNormalize(item.testName || item.failure?.testName),
        test: this.stripAnsiAndNormalize(item.testName || item.failure?.testName),
        test_name: this.stripAnsiAndNormalize(item.testName || item.failure?.testName),
        file: this.normalizePathForReport(this.stripAnsiAndNormalize(item.file || item.failure?.file || '')),
        analysis: this.stripAnsiAndNormalize(item.analysis),
        rootCause: this.stripAnsiAndNormalize(item.rootCause || item.root_cause || null),
        root_cause: this.stripAnsiAndNormalize(item.rootCause || item.root_cause || null),
        suggestedFix: this.stripAnsiAndNormalize(item.suggestedFix || item.suggested_fix || null),
        suggested_fix: this.stripAnsiAndNormalize(item.suggestedFix || item.suggested_fix || null),
        affectedFiles: this.stripAnsiAndNormalize(item.affectedFiles || null),
        testingRecommendations: this.stripAnsiAndNormalize(item.testingRecommendations || null),
        error: this.stripAnsiAndNormalize(item.error || null),
        confidence: item.confidence,
      })),
    };
  }

  buildJiraSummary(jiraData) {
    return {
      total: jiraData.length,
      stories: jiraData.map((story) => ({
        key: this.stripAnsiAndNormalize(story.key),
        summary: this.stripAnsiAndNormalize(story.summary),
        status: this.stripAnsiAndNormalize(story.status),
        acceptanceCriteria: story.acceptanceCriteria?.length || 0,
      })),
    };
  }

  stableHash(value, length = 16) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
  }

  categoryFromCatTag(value = '') {
    const match = String(value || '').match(/\[CAT:([^\]]+)\]/i);
    if (!match) return null;
    const cat = match[1].trim().toLowerCase();
    if (cat === 'a11y' || cat === 'accessibility') return 'a11y';
    if (cat === 'form_validation' || cat === 'api_negative' || cat === 'boundary_validation') return 'validation';
    if (cat === 'api_auth' || cat === 'rbac' || cat === 'authz') return 'authz';
    if (cat === 'filter_logic') return 'filter_logic';
    if (cat === 'api_contract') {
      if (/qac-filter|filter|query|search/i.test(value)) return 'filter_logic';
      return 'http_contract';
    }
    return cat.replace(/[^a-z0-9_]+/g, '_') || null;
  }

  inferQaCategory(test = {}) {
    const rawText = `${test.title || ''} ${test.file || ''} ${test.suite || ''}`;
    const taggedCategory = this.categoryFromCatTag(rawText);
    if (taggedCategory) return taggedCategory;
    const text = rawText.toLowerCase();
    if (/form_validation|form-validation|boundary|validation|required|string|whitespace|api_negative/.test(text)) return 'validation';
    if (/a11y|accessib|aria|interactive/.test(text)) return 'a11y';
    if (/rbac|authz|api_auth|forbidden|unauthorized/.test(text)) return 'authz';
    if (/filter|query|search/.test(text)) return 'filter_logic';
    if (/status|201|202|204|api_contract|contract/.test(text)) return 'http_contract';
    return 'functional';
  }

  buildSkipSummary(tests = []) {
    const skipped = (tests || []).filter((test) => this.normalizeStatus(test.status) === 'skipped');
    const byCategory = {};
    const byReason = {};
    const examples = [];
    for (const test of skipped) {
      const category = this.inferQaCategory(test);
      byCategory[category] = (byCategory[category] || 0) + 1;
      const text = `${test.error || test.errorMessage || test.title || ''}`;
      // G39: tier-aware skip classification. `missing_auth_context` only makes
      // sense in Tier A public projects — if the test ran in Tier B (where
      // auth IS configured), an auth-related skip is a setup failure, not a
      // missing-context skip. The tier comes from the Playwright project tag
      // (e.g. `tierA-public`, `tierB-auth-admin`, `tierC-backend`).
      const tierTag = String(test.tier || test.project || '').toLowerCase();
      const isTierB = tierTag.startsWith('tierb');
      let reason;
      if (/fixture|sample|dynamic|No live fixture/i.test(text)) {
        reason = 'missing_fixture_or_dynamic_sample';
      } else if (/auth|storage|role/i.test(text)) {
        reason = isTierB ? 'auth_setup_failed' : 'missing_auth_context';
      } else if (/skip/i.test(text)) {
        reason = 'explicit_skip';
      } else {
        reason = 'unspecified_skip';
      }
      byReason[reason] = (byReason[reason] || 0) + 1;
      if (examples.length < 8) {
        examples.push({
          title: this.stripAnsiAndNormalize(test.title || test.name || 'Unnamed skipped test'),
          file: this.normalizePathForReport(test.file || ''),
          category,
          reason,
        });
      }
    }
    const total = skipped.length;
    return {
      total,
      byCategory,
      byReason,
      examples,
      status: total >= 10 || total / Math.max(1, tests.length) > 0.25 ? 'coverage_degraded' : 'ok',
    };
  }

  severityForQaCategory(category, test = {}) {
    const text = `${test.title || ''} ${test.file || ''} ${test.error || ''}`.toLowerCase();
    if (category === 'authz' || /data exposure|security|admin.*users/.test(text)) return 'P0';
    if (['http_contract', 'validation', 'filter_logic'].includes(category)) return 'P1';
    if (category === 'a11y') return 'P2';
    return 'P2';
  }

  buildQaTestCaseRuns({ projectPath, projectName, tests = [] }) {
    const projectFingerprint = this.stableHash(`${projectName || ''}:${this.normalizePathForReport(projectPath || '')}`, 24);
    return (tests || []).map((test) => {
      const category = this.inferQaCategory(test);
      const stableTestId = this.stableHash(`${projectFingerprint}:${test.file || ''}:${test.title || ''}`, 24);
      const title = this.stripAnsiAndNormalize(test.title || test.name || 'Unnamed test');
      return {
        stableTestId,
        projectFingerprint,
        tier: /\[QAC:|healix-qa-contracts/i.test(`${test.title || ''} ${test.file || ''}`)
          ? 'tier0-deterministic'
          : 'tier1-ai-generated',
        category,
        title,
        file: this.normalizePathForReport(test.file || ''),
        status: this.normalizeStatus(test.status),
        duration: Number(test.duration || 0),
        sourceHash: this.stableHash(`${test.file || ''}:${title}`),
      };
    });
  }

  buildQaFindings({ projectPath, projectName, tests = [], classifierVerdicts = [] }) {
    const projectFingerprint = this.stableHash(`${projectName || ''}:${this.normalizePathForReport(projectPath || '')}`, 24);
    const findings = [];
    const seen = new Set();
    for (const test of tests || []) {
      if (this.normalizeStatus(test.status) !== 'failed') continue;
      if (test.isPipelineSynthetic || /pipeline-worker|HEALIX_ERROR/i.test(`${test.file || ''} ${test.title || ''}`)) continue;
      const verdict = (classifierVerdicts || []).find((item) =>
        item && (item.testName === test.title || item.title === test.title)
      );
      if (verdict && ['test_is_wrong', 'environment'].includes(String(verdict.verdict || ''))) continue;

      const deterministicTier0 = /\[QAC:|healix-qa-contracts/i.test(`${test.title || ''} ${test.file || ''}`);
      const classifierConfirmsAppBug = verdict && String(verdict.verdict || '') === 'app_is_wrong';
      if (!deterministicTier0 && !classifierConfirmsAppBug) continue;

      const category = this.inferQaCategory(test);
      const severity = this.severityForQaCategory(category, test);
      const signature = this.stableHash(`${projectFingerprint}:${category}:${test.file || ''}:${String(test.title || '').replace(/\d+/g, '#')}`, 24);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const errorMessage = typeof test.error === 'string'
        ? test.error
        : (test.error?.message || test.error?.value || test.error?.stack || null);
      findings.push({
        signature,
        projectFingerprint,
        severity,
        category,
        findingType: deterministicTier0 ? 'deterministic_contract' : 'app_is_wrong',
        title: this.stripAnsiAndNormalize(test.title || 'Unnamed failed QA check'),
        status: 'open',
        ownerHint: this.normalizePathForReport(test.file || ''),
        testFile: this.normalizePathForReport(test.file || ''),
        testTitle: this.stripAnsiAndNormalize(test.title || ''),
        reproducer: {
          command: `npx playwright test ${this.normalizePathForReport(test.file || '')}`.trim(),
          note: 'Generated by Healix from a failed deterministic or generated QA check.',
        },
        evidence: this.stripAnsiAndNormalize({
          error: errorMessage,
          suite: test.suite || null,
          qacMarkers: [...String(test.title || '').matchAll(/\[QAC:([^\]]+)\]/g)].map((match) => match[1]),
          attachments: test.artifacts || null,
        }),
      });
    }
    return findings;
  }

  summarizeQaFindings(findings = []) {
    const bySeverity = { P0: 0, P1: 0, P2: 0, P3: 0 };
    const byCategory = {};
    for (const finding of findings || []) {
      const severity = finding.severity || 'P3';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;
      const category = finding.category || 'unknown';
      byCategory[category] = (byCategory[category] || 0) + 1;
    }
    return {
      total: findings.length,
      bySeverity,
      byCategory,
      highestSeverity: ['P0', 'P1', 'P2', 'P3'].find((severity) => bySeverity[severity] > 0) || null,
      status: findings.length > 0 ? 'completed_with_findings' : 'completed',
    };
  }

  /**
   * Generate a test report
   */
  async generate({
    projectPath,
    projectName,
    runId,
    testResults,
    aiAnalysis,
    jiraData,
    generationMeta,
    generationQuality,
    requirementsCoverage,
    routeAccessSummary,
    phaseResults,
    tierResults,
    pipelineError,
    fallbackUsed,
    failures,
    flakyCount,
    classifierVerdicts,
    failureClusters,
    aiTriage,
    api_key,
    dashboard_url,
    workspaceId,
    parentTestRunId,
    existingTestRunId,
  }) {
    const timestamp = new Date().toISOString();
    const reportsDir = path.join(projectPath, 'healix-reports');
    this.ensureDir(reportsDir);

    if (!testResults) {
      testResults = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        tests: [],
        failures: [],
      };
    }

    if (!Array.isArray(testResults.tests)) {
      testResults.tests = [];
    }
    if (!Array.isArray(testResults.failures)) {
      testResults.failures = [];
    }

    await this.copyArtifacts(testResults, reportsDir, projectPath);
    await this.copyPlaywrightHTMLReport(projectPath, reportsDir);

    const normalizedAiTriage = this.stripAnsiAndNormalize(aiTriage || null);
    const normalizedTestsForFindings = testResults.tests || [];
    const qaFindings = this.buildQaFindings({
      projectPath,
      projectName,
      tests: normalizedTestsForFindings,
      classifierVerdicts,
    });
    const findingSummary = this.summarizeQaFindings(qaFindings);
    const qaTestCaseRuns = this.buildQaTestCaseRuns({
      projectPath,
      projectName,
      tests: normalizedTestsForFindings,
    });
    const skipSummary = this.buildSkipSummary(normalizedTestsForFindings);

    const report = {
      metadata: {
        timestamp,
        projectName: this.stripAnsiAndNormalize(projectName || path.basename(projectPath)),
        projectPath: this.normalizePathForReport(projectPath),
        version: '1.0.0',
        generator: 'healix-mcp',
        runId: this.stripAnsiAndNormalize(runId || null),
        generationMeta: generationMeta || null,
        pipelineDecisionSummary: this.stripAnsiAndNormalize(generationMeta?.pipelineDecisionSummary || null),
        pipelineDecisionLogPath: generationMeta?.pipelineDecisionLogPath
          ? this.normalizePathForReport(generationMeta.pipelineDecisionLogPath)
          : null,
        qaContractSummary: this.stripAnsiAndNormalize(generationMeta?.qaContractSummary || null),
        qaContractCoverage: this.stripAnsiAndNormalize(generationMeta?.qaContractCoverage || null),
        qaContractWarnings: this.stripAnsiAndNormalize(generationMeta?.qaContractWarnings || []),
        qaContractQuestions: this.stripAnsiAndNormalize(generationMeta?.qaContractQuestions || []),
        // WS-5: AC coverage scorecard — computed by pipeline-worker after
        // each Playwright run by scanning `[REQ:...]` tags in test titles.
        acCoverage: this.stripAnsiAndNormalize(generationMeta?.acCoverage || null),
        // WS-6: bug-detection scorecard — present when KNOWN_BUGS.md was
        // parsed at the project root.
        bugScorecard: this.stripAnsiAndNormalize(generationMeta?.bugScorecard || null),
        fallbackUsed: Boolean(fallbackUsed),
        routeAccessSummary: this.stripAnsiAndNormalize(routeAccessSummary || generationMeta?.routeAccessSummary || null),
        aiTriage: normalizedAiTriage,
        aiTriageStatus: normalizedAiTriage?.aiTriageStatus || null,
        aiTriageReason: normalizedAiTriage?.aiTriageReason || null,
        aiEligibleFailures: Number(normalizedAiTriage?.aiEligibleFailures || 0),
        deterministicVerdicts: Number(normalizedAiTriage?.deterministicVerdicts || 0),
        findingSummary,
        skipSummary,
      },
      // G49: honest pass rate. Failures are partitioned by the
      // classifier verdict into three buckets:
      //   - appBugFailures: real product defects (verdict=app_is_wrong, or
      //     unclassified high-confidence "ambiguous" — treated as app bugs
      //     unless we have evidence otherwise).
      //   - pipelineNoiseFailures: verdict=test_is_wrong (generator wrote a
      //     bad spec) OR verdict=environment (setup/auth issue, not a real
      //     product bug).
      //   - flakyFailures: verdict=flake (intermittent — not a definitive
      //     signal either way).
      // The dashboard's headline "Failed" count uses appBugFailures so the
      // pass rate reflects the actual codebase quality, not the pipeline's
      // own test-generation noise. The buckets are exposed separately so
      // operators can drill in.
      stats: (() => {
        // G57: counts are computed from the CANONICAL (deduped by file+suite+title)
        // test list, not from Playwright's raw cartesian (per-project × per-attempt)
        // total. A test that runs in tierA AND tierB = ONE canonical test. A test
        // that passes after one retry = passed (not failed-then-passed). The raw
        // totals are kept under `raw` for transparency.
        const canonicalTests = this.buildCanonicalTestsList(testResults.tests || []);
        const canonStatus = (s) => String(s || '').toLowerCase();
        const total = canonicalTests.length || Number(testResults.total || 0);
        const totalPassed = canonicalTests.filter((t) => canonStatus(t.status) === 'passed').length;
        const totalFailedAll = canonicalTests.filter((t) => canonStatus(t.status) === 'failed').length;
        const totalSkipped = canonicalTests.filter((t) => ['skipped', 'pending'].includes(canonStatus(t.status))).length;
        const flaky = Number(flakyCount ?? testResults.flaky ?? canonicalTests.filter((t) => canonStatus(t.status) === 'flaky').length);
        const cv = Array.isArray(classifierVerdicts) ? classifierVerdicts : [];
        const noiseVerdicts = new Set(['test_is_wrong', 'environment']);
        const appBugCount = cv.filter((v) => String(v?.verdict || '') === 'app_is_wrong').length;
        const noiseCount = cv.filter((v) => noiseVerdicts.has(String(v?.verdict || ''))).length;
        const ambiguousCount = cv.filter((v) => String(v?.verdict || '') === 'ambiguous').length;
        // Failures with no classifier verdict (verdict-less) are treated as app bugs
        // to avoid silently hiding signal.
        const unclassifiedCount = Math.max(0, totalFailedAll - cv.length);
        const honestFailed = Math.min(totalFailedAll, appBugCount + ambiguousCount + unclassifiedCount);
        const honestRunnable = Math.max(0, total - totalSkipped);
        const honestPassRate = honestRunnable > 0
          ? Math.round(((totalPassed + noiseCount) / honestRunnable) * 100)
          : 0;
        return {
          total,
          passed: totalPassed,
          failed: honestFailed,
          skipped: totalSkipped,
          runnable: honestRunnable,
          flaky,
          duration: Number(testResults.duration || 0),
          passRate: honestPassRate,
          // G49 + G57 transparency fields — surface both the verdict-partition
          // AND the canonicalization delta so anyone reading the report can
          // see what the un-filtered Playwright totals were.
          appBugFailures: appBugCount + ambiguousCount + unclassifiedCount,
          pipelineNoiseFailures: noiseCount,
          raw: {
            // Playwright's reported total (per-project × per-attempt).
            total: Number(testResults.total || 0),
            failed: Number(testResults.failed || 0),
            passed: Number(testResults.passed || 0),
            skipped: Number(testResults.skipped || 0),
            passRate: Number(testResults.total || 0) > 0
              ? Math.round((Number(testResults.passed || 0) / Number(testResults.total || 0)) * 100)
              : 0,
            // How many redundant rows G57 collapsed.
            duplicatesCollapsed: Math.max(0, Number(testResults.total || 0) - total),
          },
        };
      })(),
      tests: this.buildTestsList(testResults, aiAnalysis, jiraData),
      aiSummary: Array.isArray(aiAnalysis) && aiAnalysis.length > 0 ? this.buildAISummary(aiAnalysis) : null,
      jiraSummary: jiraData ? this.buildJiraSummary(jiraData) : null,
      generationQuality: this.stripAnsiAndNormalize(generationQuality || null),
      // G38: reconcile requirementsCoverage with acCoverage so the dashboard
      // doesn't show "3/3" and "17/22" side by side. When acCoverage is
      // present and richer, derive a requirementsCoverage shape from it; both
      // fields now describe the same population (covered AC IDs / total ACs).
      requirementsCoverage: (() => {
        const ac = generationMeta?.acCoverage;
        if (ac && typeof ac === 'object') {
          const covered = Array.isArray(ac.covered) ? ac.covered : (Array.isArray(ac.coveredAcIds) ? ac.coveredAcIds : null);
          const total = Number.isFinite(ac.totalAcTags) ? ac.totalAcTags : (Number.isFinite(ac.total) ? ac.total : null);
          if (covered && total != null) {
            return this.stripAnsiAndNormalize({
              coveredAcIds: covered,
              totalAcIds: total,
              ratio: total > 0 ? covered.length / total : 0,
              source: 'derived_from_acCoverage',
            });
          }
        }
        return this.stripAnsiAndNormalize(requirementsCoverage || null);
      })(),
      phaseResults: this.stripAnsiAndNormalize(phaseResults || testResults.phaseResults || null),
      tierResults: tierResults || testResults.tierResults || null,
      pipelineError: pipelineError ? this.stripAnsiAndNormalize(pipelineError) : null,
      failures: Array.isArray(failures)
        ? failures
        : this.stripAnsiAndNormalize(testResults.failures || []),
      classifierVerdicts: Array.isArray(classifierVerdicts) ? classifierVerdicts : [],
      failureClusters: Array.isArray(failureClusters) ? failureClusters : [],
      aiTriage: normalizedAiTriage,
      qaFindings: this.stripAnsiAndNormalize(qaFindings),
      findingSummary: this.stripAnsiAndNormalize(findingSummary),
      skipSummary: this.stripAnsiAndNormalize(skipSummary),
      qaTestCaseRuns: this.stripAnsiAndNormalize(qaTestCaseRuns),
      // WS-5 / WS-6: top-level surfacing so the dashboard can read
      // `testRun.report?.acCoverage` / `testRun.report?.bugScorecard`
      // without spelunking through generationMeta.
      acCoverage: this.stripAnsiAndNormalize(generationMeta?.acCoverage || null),
      bugScorecard: this.stripAnsiAndNormalize(generationMeta?.bugScorecard || null),
      // CL3-A / CL3-B — top-level breakdown + optional runStatus override.
      // `runStatus` is null in normal terminations; set when the iteration
      // controller graduates the run (`qa_cycle_complete`) or reports useful
      // execution with incomplete coverage (`coverage_degraded`).
      failureBreakdown: this.stripAnsiAndNormalize(generationMeta?.failureBreakdown || null),
      runStatus: generationMeta?.runStatus || null,
      // F6 / G75: surface specQuarantineHistory at the top level so the
      // dashboard can read it without spelunking into generationMeta.
      // Each entry: { file, gate, action, reason, iter, ts }.
      specQuarantineHistory: Array.isArray(generationMeta?.specQuarantineHistory)
        ? generationMeta.specQuarantineHistory
        : [],
      // F6 / G66: ordered list of validation gates that ran this run.
      gateStageOrder: Array.isArray(generationMeta?.gateStageOrder)
        ? generationMeta.gateStageOrder
        : [],
    };

    const reportFilename = `report-${timestamp.replace(/[:.]/g, '-')}.json`;
    const reportPath = path.join(reportsDir, reportFilename);
    const latestPath = path.join(reportsDir, 'latest.json');

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf-8');

    let dashboardLink = `file://${reportPath}`;
    let ingestSucceeded = false;
    let ingestLastStatus = null;
    let ingestLastError = null;
    if (api_key && dashboard_url) {
      const fetchFn = global.fetch || require('node-fetch');
      const ingestBody = JSON.stringify({
        api_key,
        creation_name: projectName || path.basename(projectPath),
        run_id: runId || null,
        report,
        project_path: projectPath,
        tier_results: report.tierResults || null,
        pipeline_error: report.pipelineError || null,
        failures: report.failures || [],
        flaky_count: report.stats.flaky || 0,
        classifier_verdicts: report.classifierVerdicts || [],
        failure_clusters: report.failureClusters || [],
        qa_findings: report.qaFindings || [],
        qa_test_case_runs: report.qaTestCaseRuns || [],
        finding_summary: report.findingSummary || null,
        run_status: report.runStatus || null,
        failure_breakdown: report.failureBreakdown || null,
        workspace_id: workspaceId || null,
        workspaceId: workspaceId || null,
        parent_test_run_id: parentTestRunId || null,
        parentTestRunId: parentTestRunId || null,
        existing_test_run_id: existingTestRunId || null,
        existingTestRunId: existingTestRunId || null,
      });

      // G59: retry-with-backoff. Pre-G59 the call was best-effort with a
      // warn-on-failure and no retries, which meant a single transient 5xx
      // (e.g. Supabase blip, gateway timeout) left the dashboard row with
      // total_tests=0/passed_tests=0 even though local results were fine.
      // 3 attempts with 1s, 3s, 9s backoff covers the typical blip.
      const maxAttempts = 3;
      const baseDelayMs = 1000;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await fetchFn(`${dashboard_url}/api/test-runs/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: ingestBody,
          });
          ingestLastStatus = response.status;
          if (response.ok) {
            const payload = await response.json();
            dashboardLink = `${dashboard_url}${payload.dashboard_url}`;
            if (payload.test_run_id) {
              report.metadata.actualRunId = payload.test_run_id;
              Logger.info('ReportGenerator', `Test run ingested with ID: ${payload.test_run_id}`, { attempt });
            }
            ingestSucceeded = true;
            break;
          }
          // 4xx is a permanent failure (validation, auth) — don't retry.
          if (response.status >= 400 && response.status < 500) {
            Logger.warn('ReportGenerator', 'Dashboard sync failed (non-retryable)', { status: response.status, attempt });
            break;
          }
          Logger.warn('ReportGenerator', 'Dashboard sync transient failure', { status: response.status, attempt, maxAttempts });
        } catch (error) {
          ingestLastError = error.message;
          Logger.warn('ReportGenerator', 'Dashboard sync threw error', { reason: error.message, attempt, maxAttempts });
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(3, attempt - 1)));
        }
      }
      if (!ingestSucceeded) {
        Logger.warn('ReportGenerator', 'Dashboard sync exhausted retries — dashboard row will lack counts until reconciled', {
          lastStatus: ingestLastStatus,
          lastError: ingestLastError,
        });
        // Persist the ingest failure to the local report so a reconciler
        // job (or an operator) can find it later and replay. Local report
        // file is the source of truth — write the failure metadata in
        // beside it for easy discovery.
        try {
          const failureMarkerPath = path.join(reportsDir, 'dashboard-ingest-failed.json');
          fs.writeFileSync(failureMarkerPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            runId,
            existingTestRunId: existingTestRunId || null,
            reportPath,
            latestPath,
            lastStatus: ingestLastStatus,
            lastError: ingestLastError,
            attempts: maxAttempts,
            stats: report.stats,
          }, null, 2), 'utf-8');
        } catch { /* best-effort */ }
      }
    }

    return {
      path: reportPath,
      latestPath,
      url: dashboardLink,
      actualRunId: report.metadata.actualRunId || runId,
      dashboardIngest: {
        succeeded: ingestSucceeded,
        lastStatus: ingestLastStatus,
        lastError: ingestLastError,
      },
    };
  }
}

module.exports = ReportGenerator;
