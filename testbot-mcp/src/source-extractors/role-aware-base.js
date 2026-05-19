'use strict';

/**
 * Role-aware source extraction — framework-agnostic dispatcher.
 *
 * Healix supports many UI frameworks (Next.js, Remix, Vite+React, Angular,
 * Vue, plain HTML, etc.). Each framework needs its own template parser to
 * extract role+accessibleName tuples from source files, but downstream
 * consumers (grounding validator, agent prompts, dashboard) all see the
 * SAME unified schema.
 *
 * Architecture:
 *   1. Each extractor registers itself for one or more framework labels.
 *   2. The dispatcher (this file) picks the right extractor based on the
 *      framework label produced by auto-detector.js.
 *   3. If the framework is unknown or unsupported, the dispatcher returns
 *      a graceful empty result — the rest of the pipeline still works,
 *      just without role-aware grounding. No regression.
 *
 * To add a new framework:
 *   - Implement extract() returning RoleAwareElement[]
 *   - Call registerExtractor([...frameworkLabels], extractorInstance)
 *   - Done. No changes needed in consumers.
 */

const path = require('path');
const fs = require('fs');

/**
 * @typedef {Object} RoleAwareElement
 * @property {string} role             - WAI-ARIA role: 'button' | 'link' | 'heading' | 'textbox' | 'checkbox' | 'radio' | 'image' | 'option' | 'tab' | 'cell' | string
 * @property {string} accessibleName   - Computed visible name (text content, aria-label, alt, etc.)
 * @property {boolean} isDynamic       - True if name contains template interpolation (e.g. {product.name})
 * @property {Object}  attributes      - Role-specific attributes (href, level, type, placeholder, ariaLabel)
 * @property {string}  sourceFile      - Absolute file path the element was extracted from
 * @property {string?} route           - Resolved route path when framework conventions allow (e.g. "/shop")
 * @property {string?} conditional     - Static description of conditional rendering (e.g. "items.length === 0")
 */

/**
 * @typedef {Object} ExtractionResult
 * @property {RoleAwareElement[]} elements
 * @property {string}             extractor      - Identifier of which extractor produced this
 * @property {boolean}            supported      - False when framework wasn't recognized
 * @property {string?}            warning        - Human-readable note when partial/degraded
 */

/**
 * @typedef {Object} ExtractorContract
 * @property {string}   name                                   - Unique identifier
 * @property {string[]} supportedFrameworks                    - Framework labels this handles
 * @property {(ctx: ExtractionContext) => ExtractionResult} extract
 */

/**
 * @typedef {Object} ExtractionContext
 * @property {string}   projectPath   - Absolute path to project root
 * @property {string[]} files         - List of absolute file paths to inspect
 * @property {string}   framework     - Framework label from auto-detector
 * @property {Object?}  projectInfo   - Additional project metadata (routingMode, etc.)
 */

const _extractors = new Map();        // framework label → extractor instance
const _byName = new Map();            // extractor name → instance (for telemetry)

/**
 * Register an extractor for one or more framework labels.
 * Same extractor instance can register for many frameworks (e.g. JSX handles
 * next, remix, vite-react, expo).
 */
function registerExtractor(frameworks, extractor) {
  if (!extractor || typeof extractor.extract !== 'function') {
    throw new Error('Extractor must implement extract(ctx)');
  }
  if (!extractor.name) {
    throw new Error('Extractor must declare a name');
  }
  _byName.set(extractor.name, extractor);
  for (const fw of frameworks || []) {
    if (typeof fw === 'string' && fw.length > 0) {
      _extractors.set(fw.toLowerCase(), extractor);
    }
  }
}

/**
 * Look up the extractor registered for a given framework label.
 * Returns null if none registered — caller must handle gracefully.
 */
function resolveExtractor(framework) {
  if (!framework) return null;
  return _extractors.get(String(framework).toLowerCase()) || null;
}

/**
 * Main entry point — extract role-aware elements for any supported project.
 * Never throws. Always returns an ExtractionResult; `supported: false` means
 * the framework wasn't recognized and downstream callers should fall back
 * to the legacy flat-string extraction.
 */
function extractRoleAware(ctx) {
  const safeCtx = ctx || {};
  const framework = safeCtx.framework || '';

  if (!safeCtx.projectPath || !Array.isArray(safeCtx.files) || safeCtx.files.length === 0) {
    return {
      elements: [],
      extractor: 'none',
      supported: false,
      warning: 'Missing projectPath or files',
    };
  }

  const extractor = resolveExtractor(framework);
  if (!extractor) {
    return {
      elements: [],
      extractor: 'none',
      supported: false,
      warning: `No role-aware extractor registered for framework "${framework}"`,
    };
  }

  try {
    const result = extractor.extract(safeCtx);
    return {
      elements: Array.isArray(result?.elements) ? result.elements : [],
      extractor: extractor.name,
      supported: true,
      warning: result?.warning || null,
    };
  } catch (err) {
    return {
      elements: [],
      extractor: extractor.name,
      supported: false,
      warning: `Extractor "${extractor.name}" failed: ${err.message}`,
    };
  }
}

/**
 * Filter a list of files down to those a given extractor can handle, based
 * on extension hints. Each extractor declares `fileExtensions` (e.g. ['.tsx',
 * '.jsx']) and this helper applies that filter so extractors don't have to.
 */
function filterFilesByExtensions(files, extensions) {
  if (!Array.isArray(files) || !Array.isArray(extensions)) return [];
  const normalized = extensions.map((e) => e.toLowerCase());
  return files.filter((file) => {
    if (typeof file !== 'string') return false;
    const ext = path.extname(file).toLowerCase();
    return normalized.includes(ext);
  });
}

/**
 * Safe file read — never throws, returns empty string on failure. Used by
 * every extractor so they don't reimplement defensive IO.
 */
function safeReadFile(filePath, maxBytes = 600_000) {
  try {
    if (!filePath || typeof filePath !== 'string') return '';
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    if (stat.size > maxBytes) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Resolve a source file to a route path when the framework has predictable
 * conventions. Currently supports Next.js (app/ and pages/ directories).
 * Falls back to null for frameworks without conventional file → route mapping.
 *
 * Pure function — does not read the filesystem.
 */
// Normalize framework label across the two vocabularies that coexist in the
// codebase (auto-detector uses 'next', context-gatherer uses 'nextjs').
// Pure helper so route resolution and extractor lookup agree on aliases.
function normalizeFramework(fw) {
  const v = String(fw || '').toLowerCase().trim();
  if (v === 'nextjs') return 'next';
  if (v === 'vite') return 'vite-react';
  return v;
}

function resolveRouteFromPath({ projectPath, sourceFile, framework }) {
  if (!projectPath || !sourceFile) return null;
  const fw = normalizeFramework(framework);
  const relative = path.relative(projectPath, sourceFile).split(path.sep).join('/');

  if (fw === 'next' || fw === 'remix') {
    // Next.js app router: app/<segments>/page.tsx → /<segments>
    let m = relative.match(/^(?:src\/)?app\/(.+)\/(page|layout)\.(tsx|jsx|ts|js)$/i);
    if (m) {
      const segs = m[1].split('/').filter((s) => !s.startsWith('(') && !s.startsWith('@'));
      return '/' + segs.join('/');
    }
    // Next.js pages router: pages/<segments>.tsx → /<segments>
    m = relative.match(/^(?:src\/)?pages\/(.+)\.(tsx|jsx|ts|js)$/i);
    if (m) {
      let segs = m[1].split('/');
      if (segs[segs.length - 1] === 'index') segs = segs.slice(0, -1);
      return '/' + segs.join('/');
    }
  }

  if (fw === 'vite-react' || fw === 'vite-vue' || fw === 'react') {
    // Convention-less — return null and let downstream consumers fall back.
    return null;
  }

  return null;
}

/**
 * Map a JSX-like element tag to a WAI-ARIA role. Used by JSX/Vue/HTML
 * extractors which all share most of the same HTML primitives.
 */
function inferRoleFromTag(tag) {
  if (!tag) return null;
  const lower = String(tag).toLowerCase();
  if (lower === 'button') return 'button';
  if (lower === 'a') return 'link';
  if (lower === 'img') return 'image';
  if (lower === 'nav') return 'navigation';
  if (lower === 'main') return 'main';
  if (lower === 'header') return 'banner';
  if (lower === 'footer') return 'contentinfo';
  if (lower === 'aside') return 'complementary';
  if (lower === 'select') return 'combobox';
  if (lower === 'textarea') return 'textbox';
  if (/^h[1-6]$/.test(lower)) return 'heading';
  if (lower === 'input') return null; // requires type attribute — caller resolves
  // Common design-system components — pattern-based heuristic. Conservative;
  // only maps obvious cases. Adding a custom component → just edit this map.
  if (/^button/i.test(lower) || /button$/i.test(lower)) return 'button';
  if (lower === 'link') return 'link';
  if (/^heading/i.test(lower) || /^title/i.test(lower)) return 'heading';
  if (/^(text)?(field|input)$/i.test(lower)) return 'textbox';
  if (lower === 'checkbox') return 'checkbox';
  if (lower === 'radio') return 'radio';
  return null; // unknown — caller decides whether to include or skip
}

/**
 * Map input[type=X] to its role. Centralized so every extractor that sees
 * <input> tags produces consistent role labels.
 */
function inferInputRole(type) {
  const t = String(type || '').toLowerCase().trim();
  if (!t || t === 'text' || t === 'email' || t === 'password' || t === 'tel' || t === 'url' || t === 'search' || t === 'number' || t === 'date' || t === 'time' || t === 'datetime-local') {
    return 'textbox';
  }
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
  if (t === 'file') return 'button';
  if (t === 'range') return 'slider';
  if (t === 'color') return 'textbox';
  if (t === 'hidden') return null;
  return 'textbox';
}

/**
 * Reset internal state — exposed for tests so they don't leak across cases.
 */
function _resetForTesting() {
  _extractors.clear();
  _byName.clear();
}

module.exports = {
  registerExtractor,
  resolveExtractor,
  extractRoleAware,
  filterFilesByExtensions,
  safeReadFile,
  resolveRouteFromPath,
  inferRoleFromTag,
  inferInputRole,
  _resetForTesting,
};
