'use strict';

/**
 * JSX/TSX role-aware extractor.
 *
 * Handles every React-family framework (next, remix, vite-react, expo, plain
 * react) because they all share the JSX template syntax. Adding a new React
 * framework label = just add it to `supportedFrameworks` below — no logic
 * changes.
 *
 * Approach: regex/heuristic parsing rather than full AST. Trade-offs:
 *   + No heavy dependencies (no @babel/parser, no typescript) — keeps Healix
 *     MCP install footprint small for users running locally.
 *   + Fast enough to process 100+ files in a few seconds.
 *   - Doesn't fully understand TypeScript generics, conditional types, or
 *     complex JSX expressions. Those edge cases produce isDynamic=true
 *     rather than wrong assertions — degraded gracefully.
 *
 * Output is the framework-agnostic RoleAwareElement[] defined in
 * role-aware-base.js. Downstream consumers don't care which extractor ran.
 */

const path = require('path');
const {
  filterFilesByExtensions,
  safeReadFile,
  resolveRouteFromPath,
  inferRoleFromTag,
  inferInputRole,
} = require('./role-aware-base');

const SUPPORTED_FRAMEWORKS = ['next', 'remix', 'vite-react', 'expo', 'react', 'gatsby'];
const FILE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

// Strip multi-line block comments and single-line comments so they don't
// pollute the element extraction. Conservative: skips comments inside strings.
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

// JSX self-closing or paired element opening tag.
// Matches:   <Tag prop1="value" prop2={expr} ...> OR <Tag .../>
// Captures:  [1] tag name   [2] attributes string   [3] '/' if self-closing
const ELEMENT_OPEN_RE = /<([A-Za-z][A-Za-z0-9_.-]*)(\s+[^<>]*?)?(\s*\/)?>/g;

function parseAttributes(attrString) {
  const attrs = {};
  if (!attrString) return attrs;
  // Pattern handles: name="..."  name='...'  name={...}  name (boolean)
  const ATTR_RE = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  let m;
  while ((m = ATTR_RE.exec(attrString)) !== null) {
    const key = m[1];
    if (m[2] !== undefined) attrs[key] = { value: m[2], isDynamic: false };
    else if (m[3] !== undefined) attrs[key] = { value: m[3], isDynamic: false };
    else if (m[4] !== undefined) {
      const expr = m[4].trim();
      // String literal inside braces e.g. {"text"} or {'text'}
      const strLit = expr.match(/^["'`]([^"'`]+)["'`]$/);
      if (strLit) {
        attrs[key] = { value: strLit[1], isDynamic: false };
      } else {
        attrs[key] = { value: expr, isDynamic: true };
      }
    }
  }
  return attrs;
}

// Extract visible text content between an opening tag and its matching
// closing tag. Returns { text, isDynamic }. Naive but effective for the
// shallow nesting typical of role-bearing leaf elements (buttons, links,
// headings, labels).
function extractTextContent(source, openTagEndIndex, tagName) {
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
  const rest = source.slice(openTagEndIndex);
  const m = rest.match(closeRe);
  if (!m) return { text: '', isDynamic: false };
  const slice = rest.slice(0, m.index);
  // Strip nested JSX expressions but mark dynamic when any are present.
  const hasDynamic = /\{[^}]*\}/.test(slice);
  const text = slice
    .replace(/<[^>]+>/g, ' ')      // strip nested tags
    .replace(/\{[^}]*\}/g, ' ')    // strip JSX expressions
    .replace(/\s+/g, ' ')
    .trim();
  return { text, isDynamic: hasDynamic && (!text || /\{|\$\{/.test(slice)) };
}

// Pick the best accessible-name candidate from tag, attributes, and text.
// Priority: aria-label > alt (for img) > placeholder (for input) > text content.
function pickAccessibleName(tag, attrs, text) {
  const aria = attrs['aria-label'];
  if (aria && aria.value && aria.value.trim().length > 0) {
    return { name: aria.value.trim(), isDynamic: aria.isDynamic };
  }
  const t = String(tag || '').toLowerCase();
  if (t === 'img') {
    const alt = attrs.alt;
    if (alt && alt.value) return { name: alt.value.trim(), isDynamic: alt.isDynamic };
  }
  if (t === 'input' || t === 'textarea') {
    const placeholder = attrs.placeholder;
    if (placeholder && placeholder.value) {
      return { name: placeholder.value.trim(), isDynamic: placeholder.isDynamic };
    }
  }
  if (text && text.text) {
    return { name: text.text, isDynamic: text.isDynamic };
  }
  return { name: '', isDynamic: false };
}

// Look back from the element position to find an enclosing conditional
// expression like `{items.length === 0 && (...)}`. Best-effort heuristic.
function detectConditional(source, elementIndex) {
  const before = source.slice(Math.max(0, elementIndex - 400), elementIndex);
  const match = before.match(/\{\s*([^}{]+?)\s*&&\s*\(\s*$/);
  if (match) return match[1].trim().slice(0, 120);
  return null;
}

// Tags that carry user-visible text but don't have a default ARIA role.
// We extract them as role:"text" so the grounding validator can verify
// that getByText('...') / toContainText('...') / toHaveText('...') literals
// were actually present in source.
const TEXT_BEARING_TAGS = new Set(['p', 'span', 'li', 'td', 'th', 'div', 'label', 'caption', 'figcaption', 'summary', 'dd', 'dt', 'blockquote']);

// Resolve an <input>'s accessible name from its surrounding <label> when
// the input is wrapped:  <label>...<input type="checkbox"/>...<span>X</span></label>
// Returns { name, isDynamic } or null when no wrapping label found.
function findWrappingLabelText(source, inputIndex) {
  const before = source.slice(0, inputIndex);
  // Find the nearest unclosed <label ...> before this position.
  const labelOpen = before.lastIndexOf('<label');
  if (labelOpen === -1) return null;
  const labelClose = before.indexOf('>', labelOpen);
  if (labelClose === -1) return null;
  // Check there's no </label> between labelOpen and inputIndex.
  if (before.slice(labelOpen, inputIndex).includes('</label>')) return null;
  // Find the closing </label> after the input.
  const after = source.slice(inputIndex);
  const closeIdx = after.indexOf('</label>');
  if (closeIdx === -1) return null;
  // Collect the full label inner content, then strip tags/expressions.
  const innerStart = labelClose + 1;
  const innerEnd = inputIndex + closeIdx;
  const inner = source.slice(innerStart, innerEnd);
  const hasDynamic = /\{[^}]*\}/.test(inner);
  const text = inner
    .replace(/<input[\s\S]*?\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return { name: text, isDynamic: hasDynamic };
}

function extractElementsFromSource(filePath, source) {
  const out = [];
  if (!source || source.length === 0) return out;

  const cleaned = stripComments(source);
  ELEMENT_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = ELEMENT_OPEN_RE.exec(cleaned)) !== null) {
    const tag = m[1];
    const attrString = m[2] || '';
    const selfClosing = !!m[3];
    const openTagEnd = m.index + m[0].length;

    // Skip fragment shorthand and lowercased HTML-only meta tags that don't
    // produce role-bearing UI.
    if (tag === 'Fragment' || tag === 'meta' || tag === 'link' || tag === 'script' || tag === 'style' || tag === 'head' || tag === 'html' || tag === 'body') {
      continue;
    }

    const attrs = parseAttributes(attrString);
    const tagLower = tag.toLowerCase();

    // Resolve role — input requires its `type` attribute.
    let role = inferRoleFromTag(tag);
    if (tagLower === 'input') {
      role = inferInputRole(attrs.type?.value);
    }
    // Text-bearing tags without a default ARIA role still useful for
    // grounding getByText() / toHaveText() literals.
    const isTextBearing = !role && TEXT_BEARING_TAGS.has(tagLower);
    if (!role && !isTextBearing) continue;

    const text = selfClosing
      ? { text: '', isDynamic: false }
      : extractTextContent(cleaned, openTagEnd, tag);

    let accessible = pickAccessibleName(tag, attrs, text);

    // For wrapped inputs (checkbox/radio/text inside <label>), resolve the
    // accessible name from the surrounding label text. This is critical for
    // form-filter UIs where category checkboxes have no aria-label.
    if (tagLower === 'input' && !accessible.name && (role === 'checkbox' || role === 'radio' || role === 'textbox')) {
      const labelText = findWrappingLabelText(cleaned, m.index);
      if (labelText) {
        accessible = { name: labelText.name, isDynamic: labelText.isDynamic };
      }
    }

    // For text-bearing tags, the role is just "text" and the name IS the text.
    if (isTextBearing) {
      if (!accessible.name) continue;
      role = 'text';
    }

    // Skip elements with no derivable name AND no useful attributes — they
    // can't be referenced by selectors anyway. Exception: form controls,
    // landmarks, headings, and text-bearing tags handled above.
    const structuralTags = new Set(['main', 'nav', 'header', 'footer', 'aside']);
    if (!accessible.name && !structuralTags.has(tagLower) && !/^h[1-6]$/.test(tagLower)) {
      const hasId = attrs.id?.value || attrs['data-testid']?.value || attrs.name?.value;
      if (!hasId) continue;
    }

    const conditional = detectConditional(cleaned, m.index);

    const headingLevel = /^h([1-6])$/i.exec(tag)?.[1];
    const attributes = {};
    if (attrs.href?.value) attributes.href = attrs.href.value;
    if (attrs.type?.value) attributes.type = attrs.type.value;
    if (headingLevel) attributes.level = Number(headingLevel);
    if (attrs.placeholder?.value) attributes.placeholder = attrs.placeholder.value;
    if (attrs['aria-label']?.value) attributes.ariaLabel = attrs['aria-label'].value;
    if (attrs.id?.value) attributes.id = attrs.id.value;
    if (attrs.name?.value) attributes.name = attrs.name.value;
    if (attrs['data-testid']?.value) attributes.testId = attrs['data-testid'].value;
    if (attrs.loading?.value) attributes.loading = attrs.loading.value;

    out.push({
      role,
      accessibleName: accessible.name,
      isDynamic: accessible.isDynamic,
      attributes,
      sourceFile: filePath,
      route: null, // resolved by base when framework provides conventions
      conditional,
    });
  }

  return out;
}

const jsxExtractor = {
  name: 'jsx',
  supportedFrameworks: SUPPORTED_FRAMEWORKS,
  fileExtensions: FILE_EXTENSIONS,

  extract(ctx) {
    const { projectPath, files = [], framework } = ctx || {};
    const targeted = filterFilesByExtensions(files, FILE_EXTENSIONS);
    const elements = [];

    for (const file of targeted) {
      const source = safeReadFile(file);
      if (!source) continue;
      const extracted = extractElementsFromSource(file, source);
      const route = resolveRouteFromPath({ projectPath, sourceFile: file, framework });
      for (const el of extracted) {
        if (route) el.route = route;
        elements.push(el);
      }
    }

    return { elements };
  },
};

module.exports = {
  jsxExtractor,
  // Exposed for unit tests so we can exercise the parser without IO.
  extractElementsFromSource,
};
