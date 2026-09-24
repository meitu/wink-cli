"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { stageNpmPackage, packNpmPackage } = require("../scripts/pack_npm");
const { moveLegacyCommands } = require("../src/install");
const root = path.resolve(__dirname, "..");
const before = fs.readFileSync(path.join(root, "package.json"));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wink-distributions-test-"));
try {
  const gitPackage = JSON.parse(before);
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")));
  assert.strictEqual(gitPackage.name, "wink-cli", "unmodified marketplace installer requires this exact Git package name");
  for (const pkg of [lock, lock.packages[""]]) {
    assert.strictEqual(pkg.name, gitPackage.name);
    assert.strictEqual(pkg.version, gitPackage.version);
  }
  const stage = path.join(temporary, "npm package");
  const npmPackage = stageNpmPackage(stage);
  assert.strictEqual(npmPackage.name, "meitu-wink-cli");
  assert.strictEqual(npmPackage.version, gitPackage.version);
  assert.strictEqual(npmPackage.private, undefined);
  assert.strictEqual(npmPackage.scripts, undefined);
  assert.deepStrictEqual(npmPackage.dependencies, gitPackage.dependencies);
  assert.strictEqual(npmPackage.bin[npmPackage.name], "src/cli.js");
  for (const name of ["src/cli.js", "src/install.js", "skills/wink-cli-usage/SKILL.md"]) {
    assert.deepStrictEqual(fs.readFileSync(path.join(stage, name)), fs.readFileSync(path.join(root, name)));
  }
  for (const name of [".git", ".env", ".agents", "tests", "node_modules", "scripts"]) {
    assert(!fs.existsSync(path.join(stage, name)), name + " must not ship");
  }
  const guard = spawnSync(process.execPath, [path.join(root, "scripts/block_root_publish.js")], { encoding: "utf8" });
  assert.strictEqual(guard.status, 1);
  assert.match(guard.stderr, /pack:npm/);
  const archive = packNpmPackage(path.join(temporary, "output"));
  assert.strictEqual(path.basename(archive), `meitu-wink-cli-${gitPackage.version}.tgz`);
  assert(fs.statSync(archive).size > 0);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, "package.json")), before, "packing must not mutate the Git contract");

  // Installing the Git compatibility distribution over an npm installation
  // must free only that package's command shims, and restore them if npm fails.
  const globalRoot = path.join(temporary, "node_modules");
  const previousRoot = path.join(globalRoot, "meitu-wink-cli");
  const bin = path.join(temporary, "bin");
  const backup = path.join(temporary, "backup");
  fs.mkdirSync(path.join(previousRoot, "skills/wink-cli-usage"), { recursive: true });
  fs.mkdirSync(bin); fs.mkdirSync(backup);
  fs.writeFileSync(path.join(previousRoot, "package.json"), JSON.stringify(npmPackage));
  fs.writeFileSync(path.join(previousRoot, "skills/wink-cli-usage/SKILL.md"), "existing skill");
  const shim = path.join(bin, "wink-cli.cmd");
  fs.writeFileSync(shim, 'node "%dp0%/node_modules/meitu-wink-cli/src/cli.js"');
  moveLegacyCommands(globalRoot, bin, backup, "meitu-wink-cli");
  assert(fs.existsSync(shim), "same-name upgrades are handled by npm");
  const restore = moveLegacyCommands(globalRoot, bin, backup, "wink-cli");
  assert(!fs.existsSync(shim), "Git install must accommodate the npm package's shim");
  restore();
  assert(fs.existsSync(shim));
  console.log("  ok distributions: legacy Git contract, separate public npm archive, publish guard and reverse migration");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
