"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main } = require("../src/cli");
const { WinkClient, resultUrl, taskState } = require("../src/wink_client");

const SOURCE_URL = "https://example.invalid/upload/original.mov";
const RESULT_URL = "https://example.invalid/result/processed.mov";

async function capture(fn) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = value => { out += value; return true; };
  process.stderr.write = value => { err += value; return true; };
  try { return { code: await fn(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

const finished = parameter => ({
  url: SOURCE_URL,
  result: { error_code: 0, parameter, media_info_list: [{ media_data: RESULT_URL }] },
});

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wink-watermark-result-"));
  const video = path.join(directory, "video.mov"), image = path.join(directory, "image.jpg");
  for (const file of [video, image]) fs.writeFileSync(file, "offline media fixture");
  try {
    // Use the real CLI orchestration and WinkClient.run, while replacing every I/O
    // boundary. This suite neither opens a socket nor reads a user's credentials.
    async function invoke(data, options = {}) {
      const command = options.command || "remove_watermark";
      const level = options.level || 2;
      const input = options.image ? image : video;
      const type = command === "picture_quality" ? (options.image ? 12 : 11)
        : options.image ? (level === 1 ? 8 : 95) : (level === 1 ? 3 : 94);
      const responses = Array.isArray(data) ? data : [data];
      const calls = [];
      let queryIndex = 0;
      const forbidden = () => { throw new Error("unexpected network, login or credential access"); };
      const client = new WinkClient({ baseUrl: "https://example.invalid", log: () => {} });
      client.request = forbidden;
      client.authUrl = forbidden;
      client.exchange = forbidden;
      client.withApiKey = key => {
        assert.strictEqual(key, "offline-watermark-test");
        return client;
      };
      client.aiTypeConfig = async () => {
        calls.push("config");
        return { code: 0, data: [{ type, content_type: options.image ? 1 : 2, min_time: 1, max_time_normal: 60 }] };
      };
      client.uploadFile = async file => {
        assert.strictEqual(file, input);
        calls.push("upload");
        return { resource_url: SOURCE_URL };
      };
      client.submit = async (url, submitted) => {
        assert.strictEqual(url, SOURCE_URL);
        assert.strictEqual(Number(submitted.taskType), type);
        calls.push("submit");
        return { code: 0, data: { msg_id: "offline-watermark-task" } };
      };
      client.query = async taskId => {
        assert.strictEqual(taskId, "offline-watermark-task");
        calls.push("query");
        assert.ok(queryIndex < responses.length, "terminal result must stop polling");
        return { code: 0, data: responses[queryIndex++] };
      };
      const captured = await capture(() => main([
        command, "--level", String(level), "--input", input,
        "--api-key", "offline-watermark-test", "--base-url", "https://example.invalid",
        "--interval", "0.001", "--timeout", "1", "--json",
      ], {
        createClient: () => client,
        probeMedia: () => ({ width: 640, height: 360, size: 20, ...(options.image ? {} : { duration: 2 }) }),
        auth: { readCredential: forbidden, writeCredential: forbidden, openBrowser: forbidden },
      }));
      assert.deepStrictEqual(calls, ["config", "upload", "submit", ...responses.map(() => "query")], captured.err);
      return { ...captured, summary: JSON.parse(captured.out) };
    }

    function assertFailure(run, label) {
      assert.strictEqual(run.code, 3, `${label}: ${run.err}`);
      assert.strictEqual(run.summary.ok, false, label);
      assert.strictEqual(run.summary.succeeded, 0, label);
      assert.strictEqual(run.summary.failed, 1, label);
      assert.strictEqual(run.summary.results[0].ok, false, label);
      assert.ok(!Object.hasOwn(run.summary.results[0], "result_url"), `${label}: failure must not return a result link`);
      assert.ok(!run.out.includes(SOURCE_URL) && !run.out.includes(RESULT_URL), `${label}: no successful media output`);
      assert.ok(!run.err.includes(`→ ${SOURCE_URL}`) && !run.err.includes(`→ ${RESULT_URL}`), `${label}: no completion link`);
    }

    function assertSuccess(run, url = RESULT_URL) {
      assert.strictEqual(run.code, 0, run.err);
      assert.strictEqual(run.summary.ok, true);
      assert.strictEqual(run.summary.succeeded, 1);
      assert.strictEqual(run.summary.failed, 0);
      assert.strictEqual(run.summary.results[0].ok, true);
      assert.strictEqual(run.summary.results[0].result_url, url);
    }

    // A successful transport/algorithm code does not prove that a watermark was
    // detected. The response deliberately omits data.type to exercise the type
    // carried by submit options through both run and the CLI's final validation.
    for (const parameter of [undefined, {}, { exist_watermark: false, has_watermask: 0 },
      { exist_watermark: "false", has_watermask: "0" }]) {
      assertFailure(await invoke(finished(parameter)), "no watermark detected");
    }
    for (const level of [1, 2]) {
      for (const imageInput of [false, true]) {
        assertFailure(await invoke(finished({ exist_watermark: 0 }), { level, image: imageInput }), "all watermark types reject missing target");
        assertSuccess(await invoke(finished({ exist_watermark: true }), { level, image: imageInput }));
      }
    }
    for (const parameter of [
      { exist_watermark: 1 }, { exist_watermark: "1" }, { exist_watermark: "true" },
      { existWatermark: true }, { has_watermask: 1 }, { has_watermask: "1" }, { hasWatermask: true },
      { exist_watermark: false, has_watermask: 1 },
    ]) assertSuccess(await invoke(finished(parameter)));

    // Recognizing a target still requires a real algorithm output; source_url /
    // data.url must never be presented as the result of a new-protocol task.
    assertFailure(await invoke({ url: SOURCE_URL, result: { error_code: 0, parameter: { exist_watermark: true } } }), "no algorithm output");
    assertFailure(await invoke({ url: SOURCE_URL, result: {} }), "empty new-protocol result");
    assertFailure(await invoke({ url: SOURCE_URL, result: {} }, { command: "picture_quality" }), "empty result also rejected outside watermark tasks");
    assert.throws(() => resultUrl({ data: { url: SOURCE_URL, result: {} } }), /no valid result media URL/);

    // A legacy status must not hide a newer explicit failure or pending result.
    for (const data of [
      { status: "finish", url: SOURCE_URL, result: { error_code: 29903, error_msg: "PROCESS_VIDEO_ERROR" } },
      { status: "success", error_code: 9, error_msg: "denied", ...finished({ exist_watermark: true }) },
      { status: "completed", ...finished({ exist_watermark: false }) },
    ]) assertFailure(await invoke(data), "legacy status cannot override failure");
    const pending = { status: "finish", result: { error_code: 29901, error_msg: "NOT_RESULT" }, url: SOURCE_URL };
    assertSuccess(await invoke([pending, finished({ exist_watermark: true })]));
    assert.strictEqual(taskState({ result: { error_code: 0, error_msg: "NOT_RESULT" } }, { taskType: "94" }).phase, "running");

    // Old servers without a result block retain their explicit terminal status
    // and data.url compatibility; unrelated algorithms need no target markers.
    assertSuccess(await invoke({ status: "finish", url: RESULT_URL }));
    assertSuccess(await invoke(finished(undefined), { command: "picture_quality" }));
    assertSuccess(await invoke(finished({ exist_watermark: false, exist_text: false }), { command: "picture_quality" }));

    // The generic client also supports text-removal task types, even though they
    // are not currently exposed as their own CLI command/level.
    for (const taskType of [42, 99, 43, 98, 18, 100, 21, 101]) {
      for (const parameter of [undefined, {}, { exist_text: false }, { exist_text: "0" }]) {
        assert.strictEqual(taskState(finished(parameter), { taskType }).phase, "fail", `text type ${taskType} requires a detected target`);
      }
      for (const parameter of [{ exist_text: true }, { exist_text: 1 }, { exist_text: "true" }, { existText: "1" }]) {
        assert.strictEqual(taskState(finished(parameter), { taskType: String(taskType) }).phase, "finish", `text type ${taskType} accepts a detected target`);
      }
      assert.strictEqual(taskState({ type: taskType, ...finished({ exist_text: false }) }).phase, "fail", "response type works for direct callers");
    }
    for (const taskType of [3, 94, 8, 95]) {
      assert.strictEqual(taskState({ type: taskType, ...finished({ exist_watermark: false }) }).phase, "fail");
      assert.strictEqual(taskState(finished({ exist_text: true }), { taskType }).phase, "fail", "text presence does not prove a watermark was removed");
    }
    assert.strictEqual(taskState(finished({ exist_watermark: true }), { taskType: 98 }).phase, "fail", "watermark presence does not prove text was removed");
    console.log("ok - watermark result detection, explicit failure precedence and original URL rejection (offline CLI)");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
