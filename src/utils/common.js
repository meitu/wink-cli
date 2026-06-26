'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function color(code) {
  return process.stdout.isTTY ? `\u001b[${code}m` : '';
}

function colors() {
  return {
    green: color(32),
    yellow: color(33),
    red: color(31),
    cyan: color(36),
    dim: color(2),
    reset: color(0),
  };
}

function parseFlags(flags, accepted = new Set()) {
  const opts = {};
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (!accepted.has(flag)) {
      throw new Error(`unknown option "${flag}"`);
    }
    if (flag === '-h' || flag === '--help') {
      opts.help = true;
    } else if (flag === '-f' || flag === '--force') {
      opts.force = true;
    } else if (flag === '-d' || flag === '--dest') {
      const value = flags[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${flag} requires a path`);
      }
      opts.dest = value;
      i += 1;
    }
  }
  return opts;
}

function resolvePaths(dest) {
  const baseDir = path.resolve(dest || process.env.WINK_AGENTS_HOME || os.homedir());
  const skillsDir = path.join(baseDir, '.agents', 'skills');
  const skillDest = path.join(skillsDir, 'wink-cli');
  const packageRoot = path.resolve(__dirname, '..', '..');
  const skillSrc = path.join(packageRoot, 'SKILL.md');

  return {
    baseDir,
    skillsDir,
    skillDest,
    skillSrc,
  };
}

function installSkillBundle(skillSrc, skillDest) {
  fs.mkdirSync(skillDest, { recursive: true });
  fs.copyFileSync(skillSrc, path.join(skillDest, 'SKILL.md'));
}

function copyDirectory(src, dest) {
  if (fs.cpSync) {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

module.exports = {
  colors,
  copyDirectory,
  installSkillBundle,
  parseFlags,
  resolvePaths,
};
