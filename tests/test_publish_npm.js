"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseArgs, readRootPackage, PUBLIC_NAME, DEFAULT_REGISTRY } = require("../scripts/publish_npm");

const root = path.resolve(__dirname, "..");
const before = fs.readFileSync(path.join(root, "package.json"));

const pkg = readRootPackage();
assert.strictEqual(pkg.name, "wink-cli");
assert.strictEqual(pkg.private, true);

assert.deepStrictEqual(parseArgs([]), {
  registry: DEFAULT_REGISTRY,
  dryRun: false,
  skipTests: false,
  skipPack: false,
  yes: false,
  otp: undefined,
  tarball: undefined,
  help: false,
});
assert.strictEqual(parseArgs(["--dry-run", "--yes"]).dryRun, true);
assert.strictEqual(parseArgs(["--otp", "123456"]).otp, "123456");
assert.throws(() => parseArgs(["--skip-pack", "--tarball", "a.tgz"]), /不能同时使用/);
assert.throws(() => parseArgs(["--unknown"]), /无效参数/);

assert.strictEqual(PUBLIC_NAME, "meitu-wink-cli");
assert.deepStrictEqual(fs.readFileSync(path.join(root, "package.json")), before, "helpers must not mutate package.json");
console.log("  ok publish_npm: args, root package guard and public name");
