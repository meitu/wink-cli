'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REGISTRY_KEYS = [
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wink',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinkStudio',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wink',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinkStudio',
];

const REGISTRY_VIEWS = ['64', '32'];
const INSTALL_VALUES = ['InstallLocation', 'InstallPath'];
const APP_NAMES = ['Wink', 'WinkStudio'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRegistryValue(key, valueName, view) {
  const args = ['query', key, '/v', valueName];
  if (view) {
    args.push(`/reg:${view}`);
  }

  let output;
  try {
    output = execFileSync('reg', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    return '';
  }

  const match = output.match(new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_\\w+\\s+(.+)$`, 'mi'));
  return match ? match[1].trim() : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readRegistryInstalls() {
  const installs = [];
  for (const key of REGISTRY_KEYS) {
    for (const view of REGISTRY_VIEWS) {
      const installDir = INSTALL_VALUES.map((name) => readRegistryValue(key, name, view)).find(Boolean);
      if (!installDir) {
        continue;
      }
      installs.push({
        key,
        view,
        installDir,
        displayVersion: readRegistryValue(key, 'DisplayVersion', view),
      });
    }
  }

  return installs;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (err) {
    return false;
  }
}

function addCandidate(candidates, exePath, registryInfo) {
  if (!isFile(exePath)) {
    return;
  }
  candidates.push({
    exePath,
    registryInfo,
  });
}

function collectExeCandidates(registryInfo) {
  const candidates = [];
  const root = path.normalize(registryInfo.installDir);
  const versions = unique([registryInfo.displayVersion]);

  for (const appName of APP_NAMES) {
    const appDir = path.join(root, appName);
    const exeName = `${appName}.exe`;

    for (const version of versions) {
      addCandidate(candidates, path.join(appDir, version, exeName), registryInfo);
    }

    if (isDirectory(appDir)) {
      for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          addCandidate(candidates, path.join(appDir, entry.name, exeName), registryInfo);
        }
      }
    }

    addCandidate(candidates, path.join(appDir, exeName), registryInfo);
    addCandidate(candidates, path.join(root, exeName), registryInfo);
  }

  return candidates;
}

function chooseExeCandidate(registryInstalls) {
  for (const registryInfo of registryInstalls) {
    const candidates = collectExeCandidates(registryInfo);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  return null;
}

function buildWinkCmdContent(exePath) {
  return `@echo off\r\n"%~dp0..\\${path.basename(exePath)}" --cli %*\r\n`;
}

function isPermissionError(err) {
  return Boolean(err && (err.code === 'EPERM' || err.code === 'EACCES'));
}

function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeWinkCmdElevated(cliDir, cmdPath, content) {
  const stamp = `${process.pid}-${Date.now()}`;
  const scriptPath = path.join(os.tmpdir(), `wink-cli-elevate-${stamp}.ps1`);
  const script = [
    '$ErrorActionPreference = "Stop"',
    `New-Item -ItemType Directory -Force -Path ${psSingleQuoted(cliDir)} | Out-Null`,
    `Set-Content -Path ${psSingleQuoted(cmdPath)} -Value @'`,
    content.replace(/\r?\n$/, ''),
    `'@ -Encoding ASCII`,
  ].join('\r\n');

  fs.writeFileSync(scriptPath, script, 'utf8');

  try {
    process.stdout.write('Requesting administrator permission to create wink.cmd...\n');
    const elevate = [
      'Start-Process',
      '-FilePath',
      'powershell.exe',
      '-Verb',
      'RunAs',
      '-Wait',
      '-ArgumentList',
      psSingleQuoted(`-NoProfile -ExecutionPolicy Bypass -File ${scriptPath}`),
    ].join(' ');

    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', elevate], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch (err) {
      // ignore cleanup errors
    }
  }

  if (isFile(cmdPath)) {
    return {
      action: 'created-elevated',
      cmdPath,
    };
  }

  return {
    action: 'elevation-denied',
    reason: 'Administrator permission was denied or wink.cmd could not be created',
    cmdPath,
  };
}

function writeWinkCmd(cliDir, cmdPath, content) {
  try {
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(cmdPath, content, 'utf8');
    return { action: 'created', cmdPath };
  } catch (err) {
    if (!isPermissionError(err)) {
      throw err;
    }
    return writeWinkCmdElevated(cliDir, cmdPath, content);
  }
}

function ensureWinkCmdForExe(exePath) {
  const exeDir = path.dirname(exePath);
  const cliDir = path.join(exeDir, 'cli');
  const cmdPath = path.join(cliDir, 'wink.cmd');

  if (isFile(cmdPath)) {
    return {
      action: 'exists',
      cmdPath,
      exePath,
    };
  }

  const content = buildWinkCmdContent(exePath);
  const writeResult = writeWinkCmd(cliDir, cmdPath, content);

  return {
    ...writeResult,
    exePath,
  };
}

function ensureWindowsWinkCommand() {
  if (process.platform !== 'win32') {
    return {
      action: 'skipped',
      reason: 'non-windows',
    };
  }

  const registryInstalls = readRegistryInstalls();
  if (registryInstalls.length === 0) {
    return {
      action: 'missing-registry',
      reason: 'Wink install registry key was not found',
    };
  }

  const candidate = chooseExeCandidate(registryInstalls);
  if (!candidate) {
    return {
      action: 'missing-exe',
      reason: 'Wink executable was not found under the registered install location',
      installDir: registryInstalls[0].installDir,
    };
  }

  return ensureWinkCmdForExe(candidate.exePath);
}

module.exports = {
  ensureWindowsWinkCommand,
};
