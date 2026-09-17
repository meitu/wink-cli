"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { main } = require("../src/cli");
const { WinkClient } = require("../src/wink_client");

async function capture(fn) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = value => { out += value; return true; };
  process.stderr.write = value => { err += value; return true; };
  try { return { code: await fn(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-video-repair-"));
  const video = path.join(dir, "input.mp4"), secondVideo = path.join(dir, "second.mov");
  const image = path.join(dir, "input.jpg"), output = path.join(dir, "no-download");
  for (const file of [video, secondVideo, image]) fs.writeFileSync(file, "offline fixture");
  const savedGnum = process.env.WINK_TASK_GNUM, createHash = crypto.createHash;
  process.env.WINK_TASK_GNUM = "900000017";
  let md5Calls = 0;
  crypto.createHash = function (algorithm, ...args) {
    if (String(algorithm).toLowerCase() === "md5") {
      md5Calls++;
      throw new Error("video_repair must not compare result MD5");
    }
    return createHash.call(this, algorithm, ...args);
  };

  const config = overrides => ({
    type: 987, task_type: 2, func_id: 65591, content_type: 2,
    min_time: 1, max_time_normal: 60, ...overrides,
  });
  let base, configs, uploads, submits, calls, queryCounts, duration, serverErrors;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      calls.push(url.pathname);
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.strictEqual(req.headers.api_key, "offline-video-repair");
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/task/ai_type_config") {
        assert.strictEqual(req.method, "GET");
        res.end(JSON.stringify({ code: 0, data: configs }));
      } else if (url.pathname === "/task/submit") {
        assert.strictEqual(req.method, "POST");
        submits.push(Object.fromEntries(new URLSearchParams(body)));
        res.end(JSON.stringify({ code: 0, data: { msg_id: "repair-" + submits.length } }));
      } else if (url.pathname === "/task/query") {
        const taskId = url.searchParams.get("msg_id");
        assert.match(taskId, /^repair-[1-9]\d*$/);
        const count = (queryCounts.get(taskId) || 0) + 1;
        queryCounts.set(taskId, count);
        // Exercise a real polling transition without any paid or remote request.
        res.end(JSON.stringify({ code: 0, data: count === 1
          ? { remaining_elapsed: 10, result: { error_code: 29901, error_msg: "NOT_RESULT" } }
          : { result: { error_code: 0, media_info_list: [{ media_data: base + "/results/" + taskId + ".mp4" }] }, url: base + "/original.mp4" } }));
      } else {
        throw new Error("unexpected request (including login/download): " + url.pathname);
      }
    } catch (error) {
      serverErrors.push(error);
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 500, message: error.message }));
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const forbidAuth = () => { throw new Error("offline regression must not log in or read credentials"); };
    const services = {
      auth: { openBrowser: forbidAuth, readCredential: forbidAuth, writeCredential: forbidAuth },
      createClient: options => {
        const client = new WinkClient({ ...options, baseUrl: base });
        client.authUrl = forbidAuth;
        client.exchange = forbidAuth;
        client.withApiKey = apiKey => {
          const authed = new WinkClient({ ...options, baseUrl: base, apiKey });
          authed.uploadFile = async (file, options) => {
            uploads.push(file);
            options.onProgress(0.5);
            return { resource_url: base + "/uploads/" + path.basename(file) };
          };
          return authed;
        };
        return client;
      },
      probeMedia: file => ({ width: 1920, height: 1080, size: 15, ...(file === image ? {} : { duration }) }),
    };
    function reset(nextConfigs = [config()], nextDuration = 5) {
      configs = nextConfigs; duration = nextDuration;
      uploads = []; submits = []; calls = []; queryCounts = new Map(); serverErrors = [];
    }
    async function invoke(extra = [], input = video, command = "video_repair") {
      const result = await capture(() => main([
        command, "--input", input, "--output", output, "--api-key", "offline-video-repair",
        "--interval", "0.001", "--json", ...extra,
      ], services));
      assert.deepStrictEqual(serverErrors, [], "all requests must stay on the mock task API");
      assert.ok(!fs.existsSync(output), "cloud results must not be downloaded");
      assert.strictEqual(md5Calls, 0, "no original/result MD5 comparison");
      return result;
    }
    function assertRepairSubmit(expectedType) {
      assert.strictEqual(submits.length, 1);
      assert.strictEqual(submits[0].type, String(expectedType), "submit type must come from runtime config");
      assert.strictEqual(submits[0].content_type, "2");
      assert.strictEqual(submits[0].duration, String(Math.round(duration * 1000)));
      assert.strictEqual(submits[0].source_url, base + "/uploads/input.mp4");
      assert.deepStrictEqual(JSON.parse(submits[0].type_params), { enable_shake: "1" });
      assert.deepStrictEqual(JSON.parse(submits[0].right_detail), {
        source: "1", touch_type: "4", function_id: "655", material_id: "65511",
      });
      assert.deepStrictEqual(uploads, [video]);
      assert.deepStrictEqual(calls, ["/task/ai_type_config", "/task/submit", "/task/query", "/task/query"]);
    }
    async function assertRejected(label, nextConfigs, extra = [], input = video, nextDuration = 5) {
      reset(nextConfigs, nextDuration);
      const result = await invoke(extra, input);
      assert.notStrictEqual(result.code, 0, label);
      assert.deepStrictEqual(uploads, [], label + ": rejected before upload");
      assert.deepStrictEqual(submits, [], label + ": rejected before submit");
      assert.ok(calls.every(route => route === "/task/ai_type_config"), label + ": no task/poll/download");
      return result;
    }

    // Each identity field must match; an earlier historical type=123 must not be a fallback.
    const decoys = [
      config({ type: 123, task_type: 1 }), config({ type: 123, func_id: 65590 }),
      config({ type: 123, content_type: 1 }), config({ type: 123, is_local_process: 1 }),
      config({ type: 123, is_local_process: "1" }),
    ];
    reset([...decoys, config()]);
    const defaultLevel = await invoke();
    assert.strictEqual(defaultLevel.code, 0, defaultLevel.err);
    const defaultJson = JSON.parse(defaultLevel.out);
    assert.strictEqual(defaultJson.level, 1);
    assert.strictEqual(defaultJson.level_name, "Pro");
    assert.strictEqual(defaultJson.results[0].result_url, base + "/results/repair-1.mp4");
    assertRepairSubmit(987);

    // Numeric strings returned by the API and explicit --level 1 are both supported.
    reset([config({ type: "123", task_type: "2", func_id: "65591", content_type: "2", is_local_process: "0" })], 5.25);
    const explicitLevel = await invoke(["--level", "1"]);
    assert.strictEqual(explicitLevel.code, 0, explicitLevel.err);
    assertRepairSubmit(123);

    reset();
    const batch = await invoke([], `${video},${secondVideo}`);
    assert.strictEqual(batch.code, 0, batch.err);
    assert.deepStrictEqual(uploads, [video, secondVideo]);
    assert.strictEqual(submits.length, 2, "one paid submission per input video");
    assert.deepStrictEqual([...queryCounts.values()], [2, 2]);
    assert.deepStrictEqual(calls, ["/task/ai_type_config", ...Array(2).fill(["/task/submit", "/task/query", "/task/query"]).flat()]);
    assert.deepStrictEqual(JSON.parse(batch.out).results.map(item => item.result_url), [
      base + "/results/repair-1.mp4", base + "/results/repair-2.mp4",
    ]);

    for (const decoy of decoys) await assertRejected("wrong config identity", [decoy]);
    await assertRejected("unknown local processing state", [config({ is_local_process: 2 })]);
    await assertRejected("empty config", []);
    for (const type of [undefined, null, "", 0, "bad"]) {
      const invalid = config({ type });
      if (type === undefined) delete invalid.type;
      await assertRejected("missing/invalid runtime type", [invalid]);
    }
    await assertRejected("image input", [config()], [], image);
    await assertRejected("duration below minimum", [config()], [], video, 0.5);
    await assertRejected("duration above maximum", [config()], [], video, 60.1);
    for (const extra of [["--level", "2"], ["--level", "bad"], ["--level"], ["--strength", "high"], ["--fps", "60"]]) {
      await assertRejected("unsupported option " + extra.join(" "), [config()], extra);
      assert.deepStrictEqual(calls, [], "invalid command options fail before contacting services");
    }

    // The new command must not change existing picture_quality task identities or rights.
    for (const [level, type] of [[11, 176], [12, 182]]) {
      reset([config(), { type, content_type: 2, func_id: 777, min_time: 1, max_time_normal: 60 }]);
      const previous = await invoke(["--level", String(level)], video, "picture_quality");
      assert.strictEqual(previous.code, 0, previous.err);
      assert.strictEqual(submits.length, 1);
      assert.strictEqual(submits[0].type, String(type));
      assert.deepStrictEqual(JSON.parse(submits[0].type_params), {});
      assert.deepStrictEqual(JSON.parse(submits[0].right_detail), { source: "1", touch_type: "4", function_id: "777" });
      assert.deepStrictEqual(uploads, [video]);
    }
    console.log("video_repair: dynamic Pro config, exact submit fields, polling/URL-only, pre-upload rejection and picture_quality compatibility passed");
  } finally {
    crypto.createHash = createHash;
    if (savedGnum === undefined) delete process.env.WINK_TASK_GNUM;
    else process.env.WINK_TASK_GNUM = savedGnum;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
