'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN_DIR = path.join(os.homedir(), 'bin');
const WINK_COMMAND = path.join(BIN_DIR, 'wink');
const ZPROFILE = path.join(os.homedir(), '.zprofile');
const ZSHRC = path.join(os.homedir(), '.zshrc');
const PATH_EXPORT_LINE = 'export PATH="$HOME/bin:$PATH"';

const APP_CANDIDATES = [
  {
    appPath: '/Applications/WinkStudio.app',
    binaryPath: '/Applications/WinkStudio.app/Contents/MacOS/WinkStudio',
  },
  {
    appPath: '/Applications/Wink.app',
    binaryPath: '/Applications/Wink.app/Contents/MacOS/Wink',
  },
  {
    appPath: path.join(os.homedir(), 'Applications', 'WinkStudio.app'),
    binaryPath: path.join(os.homedir(), 'Applications', 'WinkStudio.app', 'Contents', 'MacOS', 'WinkStudio'),
  },
  {
    appPath: path.join(os.homedir(), 'Applications', 'Wink.app'),
    binaryPath: path.join(os.homedir(), 'Applications', 'Wink.app', 'Contents', 'MacOS', 'Wink'),
  },
];

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function isPermissionError(err) {
  return Boolean(err && (err.code === 'EPERM' || err.code === 'EACCES'));
}

function shellDoubleQuoted(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

function buildWinkCommandContent(binaryPath) {
  return `#!/bin/bash\nexec ${shellDoubleQuoted(binaryPath)} --cli "$@"\n`;
}

function findMacWinkBinary() {
  const envBinary = process.env.WINK_APP_BINARY;
  if (envBinary && isFile(envBinary)) {
    return {
      appPath: path.dirname(path.dirname(path.dirname(envBinary))),
      binaryPath: envBinary,
    };
  }

  for (const candidate of APP_CANDIDATES) {
    if (isFile(candidate.binaryPath)) {
      return candidate;
    }
  }

  return null;
}

function sameCommandTarget(commandPath, binaryPath) {
  if (!isFile(commandPath)) {
    return false;
  }

  try {
    return fs.readFileSync(commandPath, 'utf8') === buildWinkCommandContent(binaryPath);
  } catch (err) {
    return false;
  }
}

function writeWinkCommand(binaryPath) {
  const content = buildWinkCommandContent(binaryPath);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(WINK_COMMAND, content, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(WINK_COMMAND, 0o755);
}

function profileHasUserBinPath(content) {
  return /(^|\n)\s*(?:export\s+)?PATH=.*(?:\$HOME|~)\/bin/.test(content);
}

function ensureProfilePath(profilePath) {
  let content = '';
  try {
    if (isFile(profilePath)) {
      content = fs.readFileSync(profilePath, 'utf8');
    }

    if (profileHasUserBinPath(content)) {
      return {
        profileAction: 'exists',
        profilePath,
      };
    }

    const prefix = content && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(profilePath, `${prefix}${PATH_EXPORT_LINE}\n`, 'utf8');
    return {
      profileAction: 'updated',
      profilePath,
    };
  } catch (err) {
    return {
      profileAction: 'failed',
      profilePath,
      profileReason: err.message,
    };
  }
}

function ensureShellPathConfigs() {
  const profileResults = [ensureProfilePath(ZPROFILE), ensureProfilePath(ZSHRC)];
  const failed = profileResults.filter((result) => result.profileAction === 'failed');
  const updated = profileResults.filter((result) => result.profileAction === 'updated');

  return {
    profileAction: failed.length === profileResults.length ? 'failed' : updated.length ? 'updated' : 'exists',
    profilePath: profileResults.map((result) => result.profilePath).join(', '),
    profileReason: failed.map((result) => `${result.profilePath}: ${result.profileReason}`).join('; '),
    profileResults,
  };
}

function ensureMacWinkCommand() {
  if (process.platform !== 'darwin') {
    return {
      action: 'skipped',
      reason: 'non-macos',
    };
  }

  const candidate = findMacWinkBinary();
  if (!candidate) {
    return {
      action: 'missing-app',
      reason: 'Wink application binary was not found under /Applications or ~/Applications',
    };
  }

  if (sameCommandTarget(WINK_COMMAND, candidate.binaryPath)) {
    return {
      action: 'exists',
      commandPath: WINK_COMMAND,
      binaryPath: candidate.binaryPath,
      pathMissing: !isUserBinInPath(),
      ...ensureShellPathConfigs(),
    };
  }

  try {
    writeWinkCommand(candidate.binaryPath);
  } catch (err) {
    if (isPermissionError(err)) {
      return {
        action: 'permission-denied',
        reason: `No permission to write ${WINK_COMMAND}`,
        commandPath: WINK_COMMAND,
        binaryPath: candidate.binaryPath,
        pathMissing: !isUserBinInPath(),
      };
    }
    throw err;
  }

  return {
    action: 'created',
    commandPath: WINK_COMMAND,
    binaryPath: candidate.binaryPath,
    pathMissing: !isUserBinInPath(),
    ...ensureShellPathConfigs(),
  };
}

function isUserBinInPath() {
  const userBin = path.resolve(BIN_DIR);
  return (process.env.PATH || '').split(path.delimiter).some((entry) => entry && path.resolve(entry) === userBin);
}

module.exports = {
  ensureMacWinkCommand,
};
