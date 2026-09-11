"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main, resolveEnvironment, credentialFile } = require("../src/cli");
const { WinkClient } = require("../src/wink_client");
const { UploadClient } = require("../src/upload_sdk");

async function capture(fn) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try { return { code: await fn(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-env-"));
  const originalRequest = WinkClient.prototype.request;
  const originalUpload = UploadClient.prototype.uploadFile;
  const savedKey = process.env.WINK_CLI_API_KEY, savedBase = process.env.WINK_CLI_BASE_URL;
  const savedGnum = process.env.WINK_TASK_GNUM;
  try {
    delete process.env.WINK_CLI_API_KEY;
    process.env.WINK_CLI_BASE_URL = "https://precliapi-winkcut.meitu.com";
    process.env.WINK_TASK_GNUM = "env-test-device";
    const endpoints = {
      pre: "https://precliapi-winkcut.meitu.com",
      beta: "https://betacliapi-winkcut.meitu.com",
      release: "https://cliapi-winkcut.meitu.com",
    };
    assert.deepStrictEqual(resolveEnvironment({}), { env: "release", baseUrl: endpoints.release, isTest: false },
      "legacy base-url environment variable must not change the release default");
    assert.strictEqual(new Set(Object.values(endpoints).map(credentialFile)).size, 3, "credentials are isolated");
    const input = path.join(root, "input.mp4"); fs.writeFileSync(input, "fake-video");
    for (const requested of [undefined, "pre", "beta", "release"]) {
      const env = requested || "release", base = endpoints[env];
      const requests = [], uploadFlags = []; let authUrl, cachedAt, writtenAt;
      WinkClient.prototype.request = async function (method, endpoint, params) {
        assert.strictEqual(this.baseUrl, base, endpoint);
        requests.push(endpoint);
        if (endpoint === "/init/exchange") {
          assert.strictEqual(params.once_code, new URL(authUrl).searchParams.get("once_code"));
          return { code: 0, data: { api_key: "env-test-key" } };
        }
        assert.strictEqual(this.apiKey, "env-test-key");
        if (endpoint === "/task/ai_type_config") return { code: 0, data: [
          { type: 11, name: "视频超清", content_type: 2, min_time: 1, max_time_normal: 60 },
        ] };
        if (endpoint === "/task/submit") return { code: 0, data: { msg_id: "env-task" } };
        if (endpoint === "/task/query") return { code: 0, data: { result: { error_code: 123, error_msg: "mock task failure" } } };
        throw new Error("unexpected request " + endpoint);
      };
      UploadClient.prototype.uploadFile = async function () {
        uploadFlags.push(this.config.test);
        return { data: { accessUrl: "https://example.invalid/uploaded.mp4" } };
      };
      const args = ["picture_quality", "--input", input, "--output", path.join(root, env)];
      if (requested === "pre") args.unshift("--env", requested); // global option before command
      else if (requested) args.push("--env=" + requested); // after command, equals form
      const run = await capture(() => main(args, {
        probeMedia: () => ({ duration: 10, width: 320, height: 240, size: 10 }),
        auth: {
          readCredential: (url) => { cachedAt = url; return ""; },
          writeCredential: (key, url) => { assert.strictEqual(key, "env-test-key"); writtenAt = url; },
          openBrowser: (url) => { authUrl = url; },
        },
      }));
      assert.strictEqual(run.code, 3, run.err); // expected mock algorithm failure, no download
      assert.strictEqual(new URL(authUrl).origin, base);
      assert.strictEqual(cachedAt, base); assert.strictEqual(writtenAt, base);
      assert.deepStrictEqual(uploadFlags, [env === "pre"], "real upload SDK receives the environment flag");
      assert.deepStrictEqual(requests, ["/init/exchange", "/task/ai_type_config", "/task/submit", "/task/query"]);
    }
    for (const flags of [{env:true}, {env:""}, {env:"reelase"}, {env:"dev"}, {test:true}, {"no-test":true}, {env:"pre", "base-url":"http://localhost"}]) {
      assert.throws(() => resolveEnvironment(flags));
    }
    for (const args of [["picture_quality", "--env"], ["--env=", "picture_quality"], ["--env", "dev", "picture_quality"]]) {
      const run = await capture(() => main(args));
      assert.strictEqual(run.code, 1); assert.ok(run.err.includes("--env"));
    }
    console.log("cli env: default release, pre/beta/release API routing, upload config.test, credential scope and invalid values passed");
  } finally {
    WinkClient.prototype.request = originalRequest; UploadClient.prototype.uploadFile = originalUpload;
    for (const [key, value] of [["WINK_CLI_API_KEY", savedKey], ["WINK_CLI_BASE_URL", savedBase], ["WINK_TASK_GNUM", savedGnum]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
