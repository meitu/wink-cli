"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const { readSkill } = require("../src/connector_skill");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-skill-test-"));

try {
  const guard = path.join(temp, "offline.cjs");
  fs.writeFileSync(guard, `
    function forbidden() { throw new Error('skill must not use network or subprocesses'); }
    for (const name of ['http', 'https']) {
      const mod = require(name); mod.request = forbidden; mod.get = forbidden;
    }
    global.fetch = forbidden;
    const cp = require('child_process');
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[key] = forbidden;
  `);
  const home = path.join(temp, "isolated home");
  fs.mkdirSync(home);
  function run(args) {
    const result = spawnSync(process.execPath, ["--require", guard, path.join(root, "src/cli.js"), ...args], {
      cwd: home, encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, WINK_CLI_API_KEY: "", WINK_CLI_BASE_URL: "http://127.0.0.1:1" },
    });
    assert.ifError(result.error);
    return result;
  }
  const plain = run(["skill"]);
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.strictEqual(plain.stderr, "");
  assert.ok(plain.stdout.startsWith("---\nname: wink-cli-usage\n"));
  assert.ok(plain.stdout.includes(`version: ${pkg.version}\n`));
  assert.match(plain.stdout, /--list-styles/);
  assert.match(plain.stdout, /wink-cli skill --reference http-api/);
  const structured = run(["skill", "--json"]);
  assert.strictEqual(structured.status, 0, structured.stderr);
  assert.deepStrictEqual(JSON.parse(structured.stdout), {
    name: "wink-cli-usage", cli_version: pkg.version, skill_version: pkg.version,
    reference: null, content: plain.stdout,
  });
  const reference = run(["skill", "--reference", "http-api", "--json"]);
  assert.strictEqual(reference.status, 0, reference.stderr);
  const ref = JSON.parse(reference.stdout);
  assert.strictEqual(ref.reference, "http-api");
  assert.strictEqual(ref.skill_version, pkg.version);
  assert.strictEqual(ref.content, fs.readFileSync(path.join(root, "skills/wink-cli-usage/references/http-api.md"), "utf8"));
  assert.strictEqual(run(["skill", "--reference=http-api"]).stdout, ref.content);
  assert.match(run(["skill", "--help"]).stdout, /不登录、不联网/);
  assert.match(run(["--help"]).stdout, /skill/);
  for (const args of [
    ["--reference"], ["--reference="], ["--reference", "--json"],
    ["--reference", "../package.json"], ["--reference", "constructor"],
    ["--reference", "http-api", "--reference", "http-api"], ["--json", "--json"],
    ["--unknown"], ["extra"], ["--output", home],
  ]) {
    const result = run(["skill", ...args]);
    assert.strictEqual(result.status, 1, JSON.stringify(args));
    assert.strictEqual(result.stdout, "", "invalid input must not expose documents or partial output");
  }
  assert.deepStrictEqual(fs.readdirSync(home), [], "reading Skill must not write credentials or WorkBuddy state");
  assert.throws(() => readSkill("__proto__"), /支持的值: http-api/);

  // Simulate a package installed away from the checkout and upgraded in place.
  // Content and version must come from that package, never an external Skill cache.
  const installed = path.join(temp, "installed package with spaces");
  const skillRoot = path.join(installed, "skills/wink-cli-usage");
  fs.mkdirSync(path.join(installed, "src"), { recursive: true });
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.copyFileSync(path.join(root, "src/connector_skill.js"), path.join(installed, "src/connector_skill.js"));
  function readInstalled() {
    return spawnSync(process.execPath, ["-e", "require(process.argv[1]).cmdSkill(['--json'])", path.join(installed, "src/connector_skill.js")], {
      cwd: home, encoding: "utf8",
    });
  }
  for (const [version, marker] of [["1.13.0", "before upgrade"], ["1.14.0", "after upgrade"]]) {
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ version }));
    fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `---\nname: wink-cli-usage\n---\n${marker}\n`);
    const result = readInstalled();
    assert.strictEqual(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assert.strictEqual(document.skill_version, version);
    assert.ok(document.content.includes(`version: ${version}\n`));
    assert.ok(document.content.includes(marker));
  }
  fs.unlinkSync(path.join(skillRoot, "SKILL.md"));
  const missing = readInstalled();
  assert.strictEqual(missing.status, 1);
  assert.strictEqual(missing.stdout, "");
  assert.match(missing.stderr, /安装包缺少 Skill 文档/);
  assert.ok(pkg.files.includes("skills"), "npm installation must include the Skill tree");
  console.log("  ok connector skill: offline reads, JSON, references, strict arguments, relocated install and upgrade");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
