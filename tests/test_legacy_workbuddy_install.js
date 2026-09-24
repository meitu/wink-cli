"use strict";

// Opt-in network smoke: unchanged marketplace installer, real Git/npm, isolated
// prefix. Git's URL mapping points the old hard-coded URL at a local snapshot of
// this working tree, so this can be verified before pushing production master.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { packNpmPackage } = require("../scripts/pack_npm");
const legacy = require("./fixtures/legacy_workbuddy_install.cjs");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-legacy-smoke-"));
  const beforeEnv = { ...process.env };
  try {
    const source = path.join(temp, "git-source");
    fs.mkdirSync(source);
    for (const file of [...pkg.files, "package.json", "package-lock.json", "scripts"]) {
      fs.cpSync(path.join(root, file), path.join(source, file), { recursive: true });
    }
    const userConfig = path.join(temp, "user.npmrc");
    const globalConfig = path.join(temp, "global.npmrc");
    fs.writeFileSync(userConfig, ""); fs.writeFileSync(globalConfig, "");
    const home = path.join(temp, "home"); fs.mkdirSync(home);
    // Real auth/Agent directories are never used.
    Object.assign(process.env, { HOME: home, USERPROFILE: home, npm_config_registry: "https://registry.npmjs.org/",
      npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: path.join(temp, "cache"), GIT_CONFIG_GLOBAL: userConfig, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${source}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/meitu/wink-cli.git" });
    function execute(command, args, cwd = temp) {
      const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", timeout: 180000 });
      if (result.error) throw result.error;
      assert.strictEqual(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    }
    execute("git", ["init", "--quiet"], source);
    execute("git", ["add", "."], source);
    execute("git", ["-c", "user.name=Compatibility Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Isolated working-tree fixture"], source);
    const candidates = [process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
      path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
    const npm = candidates.find(file => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
    assert(npm, "npm-cli.js is required");
    const prefix = path.join(temp, "installed with spaces");
    const globalRoot = path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules");
    const oldOptions = { npm, prefix, skipSkills: true, cache: path.join(temp, "cache") };
    const first = await legacy.install(oldOptions);
    assert.strictEqual(first, path.join(globalRoot, "wink-cli/src/cli.js"));
    assert.strictEqual(execute(process.execPath, [first, "--version"]).trim(), pkg.version);

    // Switch from Git's wink-cli to the public npm package using its own installer.
    const archive = packNpmPackage(path.join(temp, "packed"));
    const bootstrap = path.join(temp, "npm-bootstrap");
    execute(process.execPath, [npm, "install", "--prefix", bootstrap, archive,
      "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"]);
    const npmCli = path.join(bootstrap, "node_modules/meitu-wink-cli/src/cli.js");
    execute(process.execPath, [npmCli, "install", "--prefix", prefix, "--skip-skills"]);
    const publicCli = path.join(globalRoot, "meitu-wink-cli/src/cli.js");
    assert.strictEqual(execute(process.execPath, [publicCli, "--version"]).trim(), pkg.version);

    // An already-installed npm distribution must not break the old Git installer.
    const again = await legacy.install(oldOptions);
    assert.strictEqual(execute(process.execPath, [again, "--version"]).trim(), pkg.version);
    const bin = path.join(prefix, process.platform === "win32" ? "wink-cli.cmd" : "bin/wink-cli");
    assert(fs.existsSync(bin));
    if (process.platform !== "win32") assert.strictEqual(fs.realpathSync(bin), fs.realpathSync(again));
    console.log("PASS: unchanged marketplace installer -> Git wink-cli; Git -> public npm -> Git, real npm installs with spaces; no login or cloud tasks.");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in beforeEnv)) delete process.env[key];
    Object.assign(process.env, beforeEnv);
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
