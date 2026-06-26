'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { colors, installSkillBundle, parseFlags, resolvePaths } = require('../utils/common');
const { ensureMacWinkCommand } = require('../utils/mac-wink-command');
const { ensureWindowsWinkCommand } = require('../utils/windows-wink-command');

const ACCEPTED = new Set(['-f', '--force', '-d', '--dest', '-h', '--help']);

const HELP = `Usage: wink-cli install [options]

Install the bundled wink-cli skill into <home>/.agents/skills/wink-cli.

Options:
  -f, --force          Overwrite an existing installed skill
  -d, --dest <path>    Override the home directory that contains .agents/skills
  -h, --help           Show help
`;

module.exports = function install(flags) {
  const c = colors();
  let opts;
  try {
    opts = parseFlags(flags, ACCEPTED);
  } catch (err) {
    process.stderr.write(`${c.red}wink-cli install: ${err.message}${c.reset}\n\n${HELP}`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const { baseDir, skillsDir, skillDest, skillSrc } = resolvePaths(opts.dest);
  if (!fs.existsSync(skillSrc)) {
    process.stderr.write(`${c.red}wink-cli install: missing bundled SKILL.md at ${skillSrc}${c.reset}\n`);
    process.exit(1);
  }

  process.stdout.write(`${c.dim}home   : ${baseDir}${c.reset}\n`);
  process.stdout.write(`${c.dim}source : ${skillSrc}${c.reset}\n`);
  process.stdout.write(`${c.dim}target : ${skillDest}${c.reset}\n`);

  fs.mkdirSync(skillsDir, { recursive: true });
  if (fs.existsSync(skillDest)) {
    if (!opts.force) {
      process.stderr.write(
        `${c.red}wink-cli install: ${skillDest} already exists.${c.reset}\n` +
          `Re-run with ${c.cyan}--force${c.reset} or use ${c.cyan}wink-cli update${c.reset}.\n`
      );
      process.exit(1);
    }
    fs.rmSync(skillDest, { recursive: true, force: true });
  }

  installSkillBundle(skillSrc, skillDest);
  process.stdout.write(`${c.green}OK${c.reset} installed wink-cli skill -> ${c.cyan}${skillDest}${c.reset}\n`);
  reportMacWinkCommand(c);
  reportWindowsWinkCommand(c);
  process.stdout.write(`${c.dim}Open a new Cursor chat so the skill is picked up.${c.reset}\n`);
};

function reportMacWinkCommand(c) {
  let result;
  try {
    result = ensureMacWinkCommand();
  } catch (err) {
    process.stdout.write(`${c.yellow}note${c.reset}: failed to check macOS wink command: ${err.message}\n`);
    return;
  }

  if (result.action === 'skipped') {
    return;
  }

  if (result.action === 'exists') {
    process.stdout.write(`${c.green}OK${c.reset} confirmed wink command -> ${c.cyan}${result.commandPath}${c.reset}\n`);
    reportMacPathHint(c, result);
    return;
  }

  if (result.action === 'created') {
    process.stdout.write(
      `${c.green}OK${c.reset} created wink command -> ${c.cyan}${result.commandPath}${c.reset}\n` +
        `${c.dim}target : ${result.binaryPath} --cli${c.reset}\n`
    );
    reportMacPathHint(c, result);
    return;
  }

  if (result.action === 'permission-denied') {
    process.stdout.write(
      `${c.yellow}note${c.reset}: ${result.reason}\n` +
        `${c.dim}Check permissions for ${result.commandPath}, then re-run install.${c.reset}\n`
    );
    return;
  }

  process.stdout.write(`${c.yellow}note${c.reset}: ${result.reason}\n`);
}

function reportMacPathHint(c, result) {
  const profileResults = result.profileResults || [
    {
      profileAction: result.profileAction,
      profilePath: result.profilePath,
      profileReason: result.profileReason,
    },
  ];
  const failed = profileResults.filter((profile) => profile.profileAction === 'failed');

  for (const profile of failed) {
    process.stdout.write(`${c.yellow}note${c.reset}: failed to update ${profile.profilePath}: ${profile.profileReason}\n`);
  }

  if (result.pathMissing) {
    reportMacZprofileSource(c, profileResults);
  }
}

function reportMacZprofileSource(c, profileResults) {
  const sourceResult = sourceMacZshProfiles(profileResults);
  if (sourceResult.ok) {
    return;
  }

  process.stdout.write(
    `${c.yellow}note${c.reset}: ${c.cyan}~/bin${c.reset} is not in PATH for this shell yet.\n` +
      `${c.dim}Tried source zsh profiles, but verification failed: ${sourceResult.reason}${c.reset}\n`
  );
}

function sourceMacZshProfiles(profileResults) {
  const profiles = profileResults
    .map((profile) => profile.profilePath)
    .filter(Boolean);
  if (!profiles.length) {
    profiles.push(`${process.env.HOME || '~'}/.zprofile`);
  }
  const sourceCommand = profiles.map((profile) => `source ${shellArg(profile)} >/dev/null 2>&1`).join(' || true; ');
  try {
    const stdout = execFileSync(
      '/bin/zsh',
      ['-lc', `${sourceCommand} || true; command -v wink`],
      { encoding: 'utf8' }
    );
    return {
      ok: true,
      winkPath: stdout.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      reason: err.message,
    };
  }
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function reportWindowsWinkCommand(c) {
  let result;
  try {
    result = ensureWindowsWinkCommand();
  } catch (err) {
    process.stdout.write(`${c.yellow}note${c.reset}: failed to check Windows wink.cmd: ${err.message}\n`);
    return;
  }

  if (result.action === 'skipped') {
    return;
  }

  if (result.action === 'exists') {
    process.stdout.write(`${c.green}OK${c.reset} confirmed wink command -> ${c.cyan}${result.cmdPath}${c.reset}\n`);
    return;
  }

  if (result.action === 'created' || result.action === 'created-elevated') {
    const viaAdmin = result.action === 'created-elevated' ? ' (admin)' : '';
    process.stdout.write(
      `${c.green}OK${c.reset} created wink command${viaAdmin} -> ${c.cyan}${result.cmdPath}${c.reset}\n` +
        `${c.dim}target : ${result.exePath} --cli${c.reset}\n`
    );
    return;
  }

  if (result.action === 'elevation-denied') {
    process.stdout.write(
      `${c.yellow}note${c.reset}: ${result.reason}\n` +
        `${c.dim}Re-run install from an elevated terminal, or approve the UAC prompt when asked.${c.reset}\n`
    );
    return;
  }

  process.stdout.write(`${c.yellow}note${c.reset}: ${result.reason}`);
  if (result.installDir) {
    process.stdout.write(` (${result.installDir})`);
  }
  process.stdout.write('\n');
}
