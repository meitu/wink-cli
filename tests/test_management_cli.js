"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-management-test-"));
const events = path.join(temp, "events.jsonl");
const guard = path.join(temp, "guard.cjs");

try {
  fs.writeFileSync(guard, `
    const fs = require('fs');
    const path = require('path');
    const config = require(${JSON.stringify(path.join(root, "src/runtime_config.js"))});
    config.credentialFile = url => path.join(${JSON.stringify(temp)}, new URL(url).hostname, 'key');
    const record = event => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + '\\n');
    const { WinkClient } = require(${JSON.stringify(path.join(root, "src/wink_client.js"))});
    WinkClient.prototype.exchange = async function(code) {
      record({type:'exchange', code, baseUrl:this.baseUrl});
      return {code:0, data:{api_key:'fixture-only-key'}};
    };
    require(${JSON.stringify(path.join(root, "src/open_browser.js"))}).openBrowser = url => record({type:'browser',url});
    const forbidden = () => { throw new Error('unexpected real side effect'); };
    global.fetch = forbidden;
    for (const name of ['http','https']) { const mod=require(name); mod.get=forbidden; mod.request=forbidden; }
    const cp=require('child_process');
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name]=forbidden;
  `);
  function run(args, legacy = false) {
    const result = spawnSync(process.execPath, ["--require", guard,
      path.join(root, legacy ? "connector/wink-connector.js" : "src/cli.js"), ...args], {
      cwd: temp, encoding: "utf8", env: { ...process.env, WINK_CLI_BASE_URL: "", WINK_CLI_ENV: "" },
    });
    assert.ifError(result.error);
    return result;
  }
  for (const command of ["login", "status", "logout", "doctor", "skill"]) {
    const help = run([command, "--help"]);
    assert.strictEqual(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes(`wink-cli ${command}`));
  }
  assert.ok(!fs.existsSync(events), "subcommand help must not start authorization");
  assert.match(run(["--help"]).stdout, /login[\s\S]*status[\s\S]*logout[\s\S]*doctor[\s\S]*skill/);
  assert.match(run(["status"]).stdout, /WINK_AUTH=disconnected/);
  const auth = run(["login", "--open-browser", "--env", "beta"]);
  assert.strictEqual(auth.status, 0, auth.stderr);
  assert.match(auth.stdout, /WINK_AUTH=connected/);
  assert.ok(!auth.stdout.includes("fixture-only-key"));
  const recorded = fs.readFileSync(events, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepStrictEqual(recorded.map(event => event.type), ["browser", "exchange"]);
  const url = new URL(recorded[0].url);
  assert.strictEqual(url.origin, "https://beta.wink.cn");
  assert.strictEqual(recorded[1].code, url.searchParams.get("once_code"));
  assert.ok(url.searchParams.has("client_id"));
  assert.strictEqual(url.searchParams.has("op_type"), false);
  assert.match(run(["--env", "beta", "status"]).stdout, /WINK_AUTH=connected/);
  assert.match(run(["status"]).stdout, /WINK_AUTH=disconnected/, "credentials stay environment-scoped");
  const oldStatus = run(["status", "--base-url=https://betacliapi-winkcut.meitu.com"], true);
  assert.match(oldStatus.stdout, /WINK_AUTH=connected/, "legacy entry shares the same credentials");
  const doctor = JSON.parse(run(["doctor", "--env=beta", "--json"]).stdout);
  assert.strictEqual(doctor.logged_in, true);
  assert.strictEqual(doctor.skill_command, "wink-cli skill");
  const helpLogout = run(["logout", "--env=beta", "--help"]);
  assert.strictEqual(helpLogout.status, 0);
  assert.match(run(["status", "--env=beta"]).stdout, /WINK_AUTH=connected/);
  assert.strictEqual(run(["logout", "--env=beta"]).status, 0);
  assert.match(run(["status", `--base-url=${url.origin}`], true).stdout, /WINK_AUTH=disconnected/);
  assert.strictEqual(run(["doctor", "--env=wrong"]).status, 1);
  const skill = run(["skill", "--json"]);
  assert.strictEqual(skill.status, 0, skill.stderr);
  assert.strictEqual(skill.stdout, run(["skill", "--json"], true).stdout);
  assert.strictEqual(run(["skill", "--json", "--json"]).status, 1, "do not lose duplicate flags during dispatch");
  assert.strictEqual(run(["version"]).stdout, run(["--version"]).stdout);
  assert.strictEqual(run(["version"], true).stdout, run(["--version"]).stdout);
  console.log("unified CLI: management routing, safe help, auto-open, environment-scoped shared credentials, Skill and legacy compatibility passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
