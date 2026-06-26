'use strict';

const fs = require('fs');
const { colors, parseFlags, resolvePaths } = require('../utils/common');

const ACCEPTED = new Set(['-d', '--dest', '-h', '--help']);

const HELP = `Usage: wink-cli uninstall [options]

Remove the installed wink-cli skill from <home>/.agents/skills/wink-cli.

Options:
  -d, --dest <path>    Override the home directory that contains .agents/skills
  -h, --help           Show help
`;

module.exports = function uninstall(flags) {
  const c = colors();
  let opts;
  try {
    opts = parseFlags(flags, ACCEPTED);
  } catch (err) {
    process.stderr.write(`${c.red}wink-cli uninstall: ${err.message}${c.reset}\n\n${HELP}`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const { skillDest } = resolvePaths(opts.dest);
  if (!fs.existsSync(skillDest)) {
    process.stdout.write(`${c.yellow}note${c.reset}: wink-cli skill is not installed at ${skillDest}\n`);
    return;
  }

  fs.rmSync(skillDest, { recursive: true, force: true });
  process.stdout.write(`${c.green}OK${c.reset} removed wink-cli skill -> ${c.cyan}${skillDest}${c.reset}\n`);
};
