"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pkg = require("../package.json");
const { detectAgentSkillTargets, installAgentSkills } = require("../src/agent_skills");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-agent-skills-test-"));
const skillName = "wink-cli-usage";
const markerName = ".wink-cli-managed.json";
let sequence = 0;

function fixture(label) {
  const directory = path.join(temp, `${++sequence}-${label}`);
  const home = path.join(directory, "home");
  const packageRoot = path.join(directory, "global package with spaces and 'quotes'");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "skills", skillName), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "wink-cli", version: pkg.version }));
  fs.writeFileSync(path.join(packageRoot, "src", "cli.js"), "// Installed connector fixture\n");
  fs.writeFileSync(path.join(packageRoot, "skills", skillName, "SKILL.md"), "---\nname: wink-cli-usage\n---\nFULL CONTENT FROM INSTALLED CLI\n");
  return { home, packageRoot, env: {}, platform: "darwin", nodePath: process.execPath };
}

function mkdir(...parts) {
  const directory = path.join(...parts);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function normalizeTargets(targets) {
  return targets.map(({ root, agents }) => ({ root, agents: [...agents].sort() }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

function snapshot(directory) {
  const result = {};
  function visit(current, relative) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const key = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) result[key] = `symlink:${fs.readlinkSync(full)}`;
      else if (stat.isDirectory()) { result[`${key}/`] = "directory"; visit(full, key); }
      else result[key] = fs.readFileSync(full).toString("base64");
    }
  }
  visit(directory, "");
  return result;
}

function skillDirectory(options, root = path.join(options.home, ".agents", "skills")) {
  return path.join(root, skillName);
}

function assertManaged(directory) {
  const entry = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8");
  assert.match(entry, /^---\r?\n/);
  assert.match(entry, /^name:\s*["']?wink-cli-usage["']?\s*$/m);
  assert.match(entry, /^description:\s*\S/m);
  assert.ok(!entry.includes("FULL CONTENT FROM INSTALLED CLI"), "agent Skill should load the installed CLI dynamically");
  assert.ok(!entry.includes("_npx"), "the installed Skill must not reference the temporary npx cache");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(directory, markerName), "utf8")));
  return entry;
}

try {
  // Detection is restricted to already-present Agent configuration directories.
  const all = fixture("detection");
  for (const name of [".codex", ".cursor", ".claude", ".workbuddy"]) mkdir(all.home, name);
  assert.deepStrictEqual(normalizeTargets(detectAgentSkillTargets(all)), normalizeTargets([
    { root: path.join(all.home, ".agents", "skills"), agents: ["codex", "cursor"] },
    { root: path.join(all.home, ".claude", "skills"), agents: ["claude"] },
    { root: path.join(all.home, ".workbuddy", "skills"), agents: ["workbuddy"] },
  ]));
  assert.ok(!fs.existsSync(path.join(all.home, ".agents")), "detection alone must not create shared directories");

  const shared = fixture("shared");
  const sharedRoot = mkdir(shared.home, ".agents", "skills");
  const sharedTargets = detectAgentSkillTargets(shared);
  assert.strictEqual(sharedTargets.length, 1);
  assert.strictEqual(sharedTargets[0].root, sharedRoot);
  mkdir(shared.home, ".codex");
  mkdir(shared.home, ".cursor");
  const deduplicated = detectAgentSkillTargets(shared);
  assert.strictEqual(deduplicated.length, 1, "Codex, Cursor and existing shared skills must not be installed repeatedly");
  assert.ok(deduplicated[0].agents.includes("codex"));
  assert.ok(deduplicated[0].agents.includes("cursor"));

  const overrides = fixture("environment-overrides");
  const customCodex = mkdir(overrides.home, "custom codex");
  const customClaude = mkdir(overrides.home, "custom claude");
  const customWorkBuddy = mkdir(overrides.home, "custom workbuddy");
  overrides.env = { CODEX_HOME: customCodex, CLAUDE_CONFIG_DIR: customClaude, WORKBUDDY_CONFIG_DIR: customWorkBuddy };
  assert.deepStrictEqual(normalizeTargets(detectAgentSkillTargets(overrides)), normalizeTargets([
    { root: path.join(overrides.home, ".agents", "skills"), agents: ["codex"] },
    { root: path.join(customClaude, "skills"), agents: ["claude"] },
    { root: path.join(customWorkBuddy, "skills"), agents: ["workbuddy"] },
  ]));
  overrides.env.WORKBUDDY_CONFIG_DIR = customClaude;
  const sharedConfigTargets = detectAgentSkillTargets(overrides);
  assert.strictEqual(sharedConfigTargets.length, 2, "Agents sharing a physical skills root need one installation");
  assert.deepStrictEqual(sharedConfigTargets.find(target => target.root === path.join(customClaude, "skills")).agents.sort(), ["claude", "workbuddy"]);
  const noAgent = fixture("no-agent");
  assert.deepStrictEqual(detectAgentSkillTargets(noAgent), []);
  assert.deepStrictEqual(installAgentSkills(noAgent), []);
  assert.deepStrictEqual(fs.readdirSync(noAgent.home), [], "no detected Agent must leave home untouched");
  fs.writeFileSync(path.join(noAgent.home, ".codex"), "not a config directory");
  assert.deepStrictEqual(detectAgentSkillTargets(noAgent), [], "configuration files are not Agent directories");

  // Custom installation is explicit and replaces auto-detection, not in addition to it.
  const custom = fixture("explicit-directory");
  mkdir(custom.home, ".codex");
  mkdir(custom.home, ".claude");
  custom.skillDir = path.join(custom.home, "custom agent skills");
  const customResults = installAgentSkills(custom);
  assert.strictEqual(customResults.length, 1);
  assert.strictEqual(customResults[0].status, "installed");
  assert.strictEqual(customResults[0].directory, skillDirectory(custom, custom.skillDir));
  assertManaged(customResults[0].directory);
  assert.ok(!fs.existsSync(path.join(custom.home, ".agents")));
  assert.ok(!fs.existsSync(path.join(custom.home, ".claude", "skills")));

  // First install, no-op reinstall and an in-place CLI upgrade.
  const managed = fixture("managed-upgrade");
  mkdir(managed.home, ".codex");
  const first = installAgentSkills(managed);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].status, "installed");
  const managedDir = skillDirectory(managed);
  const firstEntry = assertManaged(managedDir);
  assert.ok(firstEntry.includes(managed.nodePath));
  assert.ok(firstEntry.includes("cli.js"));
  const unchangedBefore = snapshot(managedDir);
  assert.strictEqual(installAgentSkills(managed)[0].status, "unchanged");
  assert.deepStrictEqual(snapshot(managedDir), unchangedBefore, "idempotent installation must preserve file contents");
  const nextVersion = "99.1.0";
  fs.writeFileSync(path.join(managed.packageRoot, "package.json"), JSON.stringify({ name: "wink-cli", version: nextVersion }));
  fs.appendFileSync(path.join(managed.packageRoot, "skills", skillName, "SKILL.md"), "NEW CLI INSTRUCTIONS\n");
  const upgraded = installAgentSkills({ ...managed, expectedVersion: nextVersion });
  assert.strictEqual(upgraded[0].status, "updated");
  assertManaged(managedDir);
  assert.ok(fs.readFileSync(path.join(managedDir, markerName), "utf8").includes(nextVersion));
  assert.strictEqual(installAgentSkills({ ...managed, expectedVersion: nextVersion })[0].status, "unchanged");

  // A user-created Skill, changes to a managed entry, and extra files are preserved.
  for (const mode of ["unmanaged", "edited-entry", "extra-file", "invalid-marker"]) {
    const options = fixture(mode);
    mkdir(options.home, ".codex");
    const target = skillDirectory(options);
    if (mode === "unmanaged") {
      mkdir(target);
      fs.writeFileSync(path.join(target, "SKILL.md"), "A Skill owned by the user\n");
    } else {
      installAgentSkills(options);
      if (mode === "edited-entry") fs.appendFileSync(path.join(target, "SKILL.md"), "User customization\n");
      if (mode === "extra-file") fs.writeFileSync(path.join(target, "user-notes.md"), "Please keep this file\n");
      if (mode === "invalid-marker") fs.writeFileSync(path.join(target, markerName), "{invalid-json");
    }
    const before = snapshot(target);
    const reports = installAgentSkills(options);
    assert.strictEqual(reports[0].status, "skipped", mode);
    assert.deepStrictEqual(snapshot(target), before, `${mode} must be preserved exactly`);
    assert.ok(reports[0].message, "skipped targets must explain why they were preserved");
  }

  const linked = fixture("symlink-target");
  mkdir(linked.home, ".codex");
  mkdir(linked.home, ".agents", "skills");
  const realTarget = mkdir(linked.home, "user-owned-skill");
  fs.writeFileSync(path.join(realTarget, "SKILL.md"), "User owned through symlink\n");
  fs.symlinkSync(realTarget, skillDirectory(linked), "junction");
  const linkedBefore = snapshot(linked.home);
  assert.strictEqual(installAgentSkills(linked)[0].status, "skipped");
  assert.deepStrictEqual(snapshot(linked.home), linkedBefore, "target symlinks must not be followed or replaced");

  // Generated commands quote executable/package paths for the target shell.
  const posix = fixture("posix-quoting");
  mkdir(posix.home, ".codex");
  posix.nodePath = "/opt/Node's folder/node";
  const posixEntry = assertManaged(installAgentSkills(posix)[0].directory);
  function containsPosixQuoted(text, value) {
    return ["'" + value.replace(/'/g, "'\\''") + "'", "'" + value.replace(/'/g, "'\"'\"'") + "'"].some(quoted => text.includes(quoted));
  }
  assert.ok(containsPosixQuoted(posixEntry, posix.nodePath), "POSIX Node executable must be shell-quoted");
  assert.ok(containsPosixQuoted(posixEntry, path.join(posix.packageRoot, "src", "cli.js")), "POSIX connector path must be shell-quoted");
  const windows = fixture("windows-quoting");
  mkdir(windows.home, ".claude");
  windows.platform = "win32";
  windows.nodePath = "C:\\Program Files\\Node's tools\\node.exe";
  const windowsEntry = assertManaged(installAgentSkills(windows)[0].directory);
  assert.ok(windowsEntry.includes("& '" + windows.nodePath.replace(/'/g, "''") + "'"), "PowerShell must use a call operator and quote the executable");
  assert.ok(windowsEntry.includes("'" + path.join(windows.packageRoot, "src", "cli.js").replace(/'/g, "''") + "'"));

  // WorkBuddy metadata retains user properties when the CLI upgrades its Skill.
  const workbuddy = fixture("workbuddy-metadata");
  mkdir(workbuddy.home, ".workbuddy");
  const wbResult = installAgentSkills(workbuddy)[0];
  assert.strictEqual(wbResult.status, "installed");
  const userMetaFile = path.join(wbResult.directory, "_user_meta.json");
  const userMeta = JSON.parse(fs.readFileSync(userMetaFile, "utf8"));
  assert.strictEqual(userMeta.source, "userImport");
  assert.strictEqual(userMeta.version, pkg.version);
  assert.ok(userMeta.name);
  assert.ok(userMeta.installedAt);
  userMeta.customProperty = { keep: true };
  fs.writeFileSync(userMetaFile, JSON.stringify(userMeta));
  fs.writeFileSync(path.join(workbuddy.packageRoot, "package.json"), JSON.stringify({ name: "wink-cli", version: nextVersion }));
  assert.strictEqual(installAgentSkills({ ...workbuddy, expectedVersion: nextVersion })[0].status, "updated");
  const updatedMeta = JSON.parse(fs.readFileSync(userMetaFile, "utf8"));
  assert.deepStrictEqual(updatedMeta.customProperty, { keep: true });
  assert.strictEqual(updatedMeta.installedAt, userMeta.installedAt);
  assert.strictEqual(updatedMeta.version, nextVersion);

  // One inaccessible destination must not prevent other Agent installations.
  const partial = fixture("partial-failure");
  mkdir(partial.home, ".claude");
  mkdir(partial.home, ".workbuddy");
  fs.writeFileSync(path.join(partial.home, ".claude", "skills"), "block creation with a regular file");
  const reports = installAgentSkills(partial);
  assert.strictEqual(reports.length, 2);
  const failed = reports.find(result => result.agents.includes("claude"));
  const succeeded = reports.find(result => result.agents.includes("workbuddy"));
  assert.strictEqual(failed.status, "error");
  assert.ok(failed.message);
  assert.strictEqual(succeeded.status, "installed");
  assertManaged(succeeded.directory);
  assert.strictEqual(fs.readFileSync(path.join(partial.home, ".claude", "skills"), "utf8"), "block creation with a regular file");

  // Detection failures are local to the affected Agent, including dangling roots.
  const dangling = fixture("dangling-skills-root");
  mkdir(dangling.home, ".claude");
  mkdir(dangling.home, ".workbuddy");
  const danglingSkills = path.join(dangling.home, ".claude", "skills");
  const nonexistent = path.join(dangling.home, "missing-skills-root");
  fs.symlinkSync(nonexistent, danglingSkills, "junction");
  const danglingReports = installAgentSkills(dangling);
  assert.strictEqual(danglingReports.length, 2);
  assert.strictEqual(danglingReports.find(result => result.agents.includes("claude")).status, "error");
  const danglingSuccess = danglingReports.find(result => result.agents.includes("workbuddy"));
  assert.strictEqual(danglingSuccess.status, "installed");
  assertManaged(danglingSuccess.directory);
  assert.ok(fs.lstatSync(danglingSkills).isSymbolicLink(), "a dangling skills root must remain a symlink");
  assert.strictEqual(fs.readlinkSync(danglingSkills), nonexistent);
  assert.ok(!fs.existsSync(nonexistent), "installation must not create a dangling symlink's destination");

  const detectionDenied = fixture("inaccessible-agent-config");
  const deniedConfig = mkdir(detectionDenied.home, ".claude");
  mkdir(detectionDenied.home, ".workbuddy");
  const statSync = fs.statSync;
  let detectionDeniedReports;
  try {
    fs.statSync = function (file, ...rest) {
      if (file === deniedConfig) {
        const error = new Error("simulated Agent configuration EACCES");
        error.code = "EACCES";
        throw error;
      }
      return statSync.call(fs, file, ...rest);
    };
    detectionDeniedReports = installAgentSkills(detectionDenied);
  } finally { fs.statSync = statSync; }
  assert.strictEqual(detectionDeniedReports.length, 2);
  const deniedReport = detectionDeniedReports.find(result => result.agents.includes("claude"));
  assert.strictEqual(deniedReport.status, "error");
  assert.match(deniedReport.message, /EACCES/);
  assert.deepStrictEqual(fs.readdirSync(deniedConfig), [], "inaccessible Agent configurations must not receive any new files or directories");
  const detectionSuccess = detectionDeniedReports.find(result => result.agents.includes("workbuddy"));
  assert.strictEqual(detectionSuccess.status, "installed");
  assertManaged(detectionSuccess.directory);

  // If replacing an installed Skill fails, its previous version is restored.
  const rollback = fixture("failed-upgrade-rollback");
  mkdir(rollback.home, ".codex");
  installAgentSkills(rollback);
  const rollbackTarget = skillDirectory(rollback);
  const rollbackBefore = snapshot(path.dirname(rollbackTarget));
  fs.writeFileSync(path.join(rollback.packageRoot, "package.json"), JSON.stringify({ name: "wink-cli", version: nextVersion }));
  const renameSync = fs.renameSync;
  let failedReplacement = false;
  try {
    fs.renameSync = function (source, destination, ...rest) {
      if (!failedReplacement && destination === rollbackTarget && path.basename(source).startsWith(".wink-cli-stage-")) {
        failedReplacement = true;
        const error = new Error("simulated replacement failure");
        error.code = "EACCES";
        throw error;
      }
      return renameSync.call(fs, source, destination, ...rest);
    };
    const failedUpgrade = installAgentSkills({ ...rollback, expectedVersion: nextVersion });
    assert.ok(failedReplacement);
    assert.strictEqual(failedUpgrade[0].status, "error");
    assert.match(failedUpgrade[0].message, /simulated replacement failure/);
  } finally { fs.renameSync = renameSync; }
  assert.deepStrictEqual(snapshot(path.dirname(rollbackTarget)), rollbackBefore, "failed replacement must restore the original and remove temporary staging files");

  // An unrelated, incomplete or mismatched installed package cannot own Agent files.
  for (const mode of ["wrong-name", "wrong-version", "missing-cli", "missing-skill"]) {
    const options = fixture(`invalid-package-${mode}`);
    mkdir(options.home, ".codex");
    if (mode === "wrong-name") fs.writeFileSync(path.join(options.packageRoot, "package.json"), JSON.stringify({ name: "another-package", version: pkg.version }));
    if (mode === "wrong-version") fs.writeFileSync(path.join(options.packageRoot, "package.json"), JSON.stringify({ name: "wink-cli", version: "0.0.0" }));
    if (mode === "missing-cli") fs.unlinkSync(path.join(options.packageRoot, "src", "cli.js"));
    if (mode === "missing-skill") fs.unlinkSync(path.join(options.packageRoot, "skills", skillName, "SKILL.md"));
    const before = snapshot(options.home);
    assert.throws(() => installAgentSkills(options), undefined, mode);
    assert.deepStrictEqual(snapshot(options.home), before, "package validation must finish before touching Agent directories");
  }

  console.log("  ok agent skills: detection, deduplication, explicit directories, managed upgrades, conflict preservation, shell quoting, WorkBuddy metadata and partial failures");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
