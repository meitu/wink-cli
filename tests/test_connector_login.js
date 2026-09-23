"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { openBrowser } = require("../src/open_browser");

// Exercise the real login loop without launching a browser, making HTTP calls,
// writing credentials, or waiting five minutes.
async function login({ platform = "darwin", autoOpen = true, failOpen = false, timeout = false } = {}) {
  const code = "abcdefghijklmnopqrstuvwx01234567";
  const url = `https://wink.cn/init/auth?once_code=${code}&client_id=1189857724`;
  const events = [], writes = [], queries = [], launches = [];
  let now = 0, stdout = "", stderr = "";
  const context = {
    module: { exports: {} },
    process: {
      env: {}, versions: { node: "18.20.8" },
      stdout: { isTTY: false, write(text) { stdout += text; events.push("output"); } },
      stderr: { isTTY: false, write(text) { stderr += text; } },
    },
    Date: { now: () => now },
    setTimeout(resolve, ms) { now += ms; resolve(); },
    require(name) {
      if (name === "fs") return {
        mkdirSync() {},
        writeFileSync(...args) { writes.push(args); },
      };
      if (name === "path") return path;
      if (name === "./wink_client") return {
        WinkClient: class {
          authUrl() { events.push("auth-url"); return { auth_url: url, once_code: code }; }
          async exchange(onceCode) {
            events.push("exchange"); queries.push(onceCode);
            if (timeout || queries.length === 1) throw new Error("pending authorization");
            return { code: 0, data: { api_key: "fixture-key" } };
          }
        },
        responseOk: payload => payload.code === 0,
        dataObject: payload => payload.data,
      };
      if (name === "./runtime_config") return {
        credentialFile: () => "/fixture/credentials/key",
        ENVIRONMENTS: { release: "https://cliapi-winkcut.meitu.com" }, DEFAULT_ENV: "release",
      };
      if (name === "./connector_skill") return { cmdSkill() {} };
      if (name === "../package.json") return { version: "1.13.1" };
      if (name === "./open_browser") return {
        openBrowser(link) {
          events.push("open");
          assert.ok(stdout.includes(link), "print the fallback link before opening");
          openBrowser(link, {
            platform,
            onError(error) { stderr += `无法自动打开浏览器：${error.message}。请手动打开链接：${link}\n`; },
            spawnProcess(command, args, options) {
              launches.push({ command, args, options });
              if (failOpen) throw new Error("fixture: browser blocked");
              const child = new EventEmitter(); child.unref = () => {}; return child;
            },
          });
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/management_commands.js"), "utf8"), context);
  const result = await context.module.exports.cmdLogin(autoOpen ? ["--open-browser"] : []);
  assert.strictEqual(events.filter(event => event === "auth-url").length, 1);
  assert.ok(queries.every(value => value === code), "keep polling the same authorization code");
  assert.strictEqual(launches.length, autoOpen ? 1 : 0, "open once even when authorization is pending");
  if (autoOpen) assert.ok(events.indexOf("open") < events.indexOf("exchange"));
  if (timeout) {
    assert.strictEqual(result, 1); assert.strictEqual(now, 300000);
    assert.strictEqual(writes.length, 0); assert.match(stderr, /授权超时/);
  } else {
    assert.strictEqual(result, 0); assert.match(stdout, /WINK_AUTH=connected/);
    assert.strictEqual(writes.length, 1); assert.strictEqual(writes[0][1], "fixture-key\n");
    assert.ok(!stdout.includes("fixture-key"));
  }
  if (autoOpen && platform === "win32") {
    assert.strictEqual(launches[0].options.env.WINK_CLI_BROWSER_URL, url);
  } else if (autoOpen) assert.deepStrictEqual(launches[0].args, [url]);
  if (failOpen) assert.ok(stderr.includes(url), "browser failure must retain manual fallback and polling");
}

(async () => {
  for (const platform of ["darwin", "win32", "linux"]) await login({ platform });
  await login({ autoOpen: false }); // Panel-owned authentication keeps its existing behavior.
  await login({ failOpen: true });
  await login({ timeout: true });
  console.log("connector login: non-TTY browser opening, panel compatibility, same-code polling, fallback and timeout passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
