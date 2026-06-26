'use strict';

const install = require('./install');

module.exports = function update(flags) {
  const nextFlags = flags.includes('-f') || flags.includes('--force')
    ? flags
    : ['--force', ...flags];
  install(nextFlags);
};
