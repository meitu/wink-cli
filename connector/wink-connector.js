#!/usr/bin/env node
"use strict";
// Compatibility entry for already-installed WorkBuddy connectors.
// New integrations use wink-cli login/status/logout/doctor/skill.
const commands = require("../src/management_commands");
if (require.main === module) {
  commands.main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write(`错误: ${error.message || error}\n`);
      process.exitCode = 1;
    });
}
module.exports = commands;
