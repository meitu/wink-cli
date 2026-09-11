"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-install-test-"));
const log = path.join(temp, "calls.jsonl");
const prefix = path.join(temp, "prefix with spaces");
const fakeNpm = path.join(temp, "npm-cli.js");

try {
  fs.writeFileSync(fakeNpm, `
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.WINK_INSTALL_TEST_LOG, JSON.stringify(args) + '\\n');
    if (args[0] === 'prefix') {
      console.log(args[args.indexOf('--prefix') + 1]);
    } else if (args[0] === 'pack') {
      const dir = args[args.indexOf('--pack-destination') + 1];
      fs.writeFileSync(path.join(dir, 'wink-test.tgz'), 'fixture');
      console.log(JSON.stringify([{filename: 'wink-test.tgz'}]));
    } else if (args[0] === 'install') {
      if (!fs.existsSync(args[2])) process.exit(9);
      if (process.env.WINK_INSTALL_TEST_FAIL) {
        console.error('EACCES fixture');
        process.exit(1);
      }
    } else process.exit(8);
  `);
  function run(args, extraEnv = {}) {
    return spawnSync(process.execPath, [path.join(root, "src/cli.js"), ...args], {
      cwd: temp,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: fakeNpm, WINK_INSTALL_TEST_LOG: log, ...extraEnv },
    });
  }
  const help = run(["install", "--help"]);
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /npx github:meitu\/wink-cli install/);
  assert.ok(!fs.existsSync(log), "help must not install or log in");
  for (const args of [["--prefix"], ["--prefix="], ["--force"], ["extra"]]) {
    const result = run(["install", ...args]);
    assert.strictEqual(result.status, 1, JSON.stringify(args));
    assert.ok(!fs.existsSync(log), "invalid input must not invoke npm");
  }
  const installed = run(["install", "--prefix", prefix]);
  assert.strictEqual(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /安装完成/);
  let calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepStrictEqual(calls.map(args => args[0]), ["prefix", "pack", "install"]);
  assert.strictEqual(calls[1][1], root);
  assert.ok(calls[1].includes("--ignore-scripts"));
  assert.ok(calls[2][2].endsWith(".tgz"), "install an archive, never link to npx cache");
  assert.strictEqual(calls[2][calls[2].indexOf("--prefix") + 1], prefix);
  assert.ok(!fs.existsSync(path.dirname(calls[2][2])), "temporary archive must be removed");
  fs.unlinkSync(log);
  const failed = run(["install", "--prefix", prefix], { WINK_INSTALL_TEST_FAIL: "1" });
  assert.strictEqual(failed.status, 1);
  assert.match(failed.stderr, /EACCES/);
  assert.ok(!failed.stdout.includes("安装完成"));
  calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(!fs.existsSync(path.dirname(calls[2][2])), "cleanup also runs on failure");
  const pkg = require("../package.json");
  assert.strictEqual(pkg.bin[pkg.name], pkg.bin["wink-cli"], "npx must select the main CLI unambiguously");
  assert.ok(!Object.hasOwn(pkg.bin, "wink"), "old command must not be installed");
  console.log("  ok install: help, validation, archive install, paths with spaces, failure and cleanup");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
