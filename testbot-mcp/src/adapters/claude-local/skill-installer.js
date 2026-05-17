'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Logger = require('../../logger');

const SKILL_NAME = 'healix-qa-engineer';
const SKILL_VERSION = '2026-05-token-reduction-v1';
const PACKAGE_SKILL_DIR = path.join(__dirname, 'skills', SKILL_NAME);

function shaFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  visit(root);
  return out.sort();
}

function skillRoot(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'skills', SKILL_NAME);
}

function installHealixSkill({ homeDir = os.homedir(), enabled = process.env.HEALIX_CLAUDE_INSTALL_SKILL !== 'false' } = {}) {
  if (!enabled) {
    return {
      skillInstalled: false,
      skillSkipped: true,
      skillName: SKILL_NAME,
      skillVersion: SKILL_VERSION,
      reason: 'disabled',
    };
  }
  if (!fs.existsSync(PACKAGE_SKILL_DIR)) {
    return {
      skillInstalled: false,
      skillSkipped: true,
      skillName: SKILL_NAME,
      skillVersion: SKILL_VERSION,
      reason: 'packaged_skill_missing',
    };
  }

  const targetRoot = skillRoot(homeDir);
  fs.mkdirSync(targetRoot, { recursive: true });

  const files = listFiles(PACKAGE_SKILL_DIR);
  let changed = 0;
  const manifest = {};
  for (const source of files) {
    const rel = path.relative(PACKAGE_SKILL_DIR, source);
    const dest = path.join(targetRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const sourceHash = shaFile(source);
    manifest[rel] = sourceHash;
    const same = fs.existsSync(dest) && shaFile(dest) === sourceHash;
    if (!same) {
      fs.copyFileSync(source, dest);
      changed += 1;
    }
  }

  const manifestPath = path.join(targetRoot, '.healix-skill-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: SKILL_NAME,
    version: SKILL_VERSION,
    installedAt: new Date().toISOString(),
    files: manifest,
  }, null, 2));

  const result = {
    skillInstalled: true,
    skillChanged: changed > 0,
    changedFiles: changed,
    skillName: SKILL_NAME,
    skillVersion: SKILL_VERSION,
    skillPath: targetRoot,
    manifestPath,
  };
  Logger.info('ClaudeLocal/SkillInstaller', 'Healix Claude skill ready', {
    skillName: SKILL_NAME,
    skillVersion: SKILL_VERSION,
    changedFiles: changed,
    skillPath: targetRoot,
  });
  return result;
}

module.exports = {
  SKILL_NAME,
  SKILL_VERSION,
  PACKAGE_SKILL_DIR,
  installHealixSkill,
  skillRoot,
  _internals: { listFiles, shaFile },
};
