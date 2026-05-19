'use strict';

/**
 * Source-extractors registry — single entry point for the rest of Healix.
 *
 * Each new framework extractor only needs:
 *   1. require it here
 *   2. registerExtractor(supportedFrameworks, extractorInstance)
 *
 * Downstream code (context-gatherer.js, grounding validator, etc.) imports
 * `extractRoleAware` from this file and never touches individual extractors.
 * That keeps the architecture pluggable: adding Vue support means writing
 * vue-extractor.js and adding two lines here. No consumer changes.
 */

const base = require('./role-aware-base');
const { jsxExtractor } = require('./jsx-extractor');

// JSX/TSX — covers next, remix, vite-react, expo, plain react, gatsby.
// Two label vocabularies coexist in the codebase: auto-detector.js uses
// 'next' / 'vite-react' while context-gatherer.js uses 'nextjs' / 'vite'.
// Register under both so the dispatcher works regardless of which caller
// supplied the framework.
const jsxFrameworkAliases = [
  ...jsxExtractor.supportedFrameworks,
  'nextjs',
  'vite',
  'nuxt',  // nuxt is Vue-based but many projects ship JSX bridges — fallback rather than skip
];
base.registerExtractor(jsxFrameworkAliases, jsxExtractor);

// Future:
//   const { vueExtractor } = require('./vue-extractor')
//   base.registerExtractor(vueExtractor.supportedFrameworks, vueExtractor)
//
//   const { angularExtractor } = require('./angular-extractor')
//   base.registerExtractor(angularExtractor.supportedFrameworks, angularExtractor)
//
//   const { htmlExtractor } = require('./html-extractor')
//   base.registerExtractor(htmlExtractor.supportedFrameworks, htmlExtractor)

module.exports = {
  extractRoleAware: base.extractRoleAware,
  resolveExtractor: base.resolveExtractor,
  registerExtractor: base.registerExtractor,
};
