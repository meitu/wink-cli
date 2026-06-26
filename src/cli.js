'use strict';

const install = require('./commands/install');
const update = require('./commands/update');
const uninstall = require('./commands/uninstall');

const HELP = `Usage: wink-cli <command> [options]

Commands:
  install      Install the wink-cli skill into ~/.agents/skills/wink-cli
  update       Overwrite the installed wink-cli skill
  uninstall    Remove the installed wink-cli skill

Options:
  -f, --force          Overwrite existing files during install
  -d, --dest <path>    Override the home directory that contains .agents/skills
  -h, --help           Show help

Examples:
  npx wink-cli install
  npx wink-cli install --force
  npx wink-cli update
  npx wink-cli uninstall
`;

function main(argv) {
  const [command, ...flags] = argv;

  if (!command || command === 'install') {
    install(flags);
    return;
  }

  if (command === 'update') {
    update(flags);
    return;
  }

  if (command === 'uninstall') {
    uninstall(flags);
    return;
  }

  if (command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  process.stderr.write(`wink-cli: unknown command "${command}"\n\n${HELP}`);
  process.exit(1);
}

main(process.argv.slice(2));
