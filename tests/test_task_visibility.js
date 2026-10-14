"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WinkClient, WinkError } = require("../src/wink_client");
const { main } = require("../src/cli");
const completed = { code: 0, data: { result: { error_code: 0,
  media_info_list: [{ media_data: "https://example.test/result.mp4" }] } } };

function fixture(responses) {
  const client = new WinkClient({ log() {} });
  const ids = [], trace = [];
  let submits = 0;
  client.submit = async () => { submits++; return { code: 0, data: { msg_id: "accepted-task" } }; };
  client.query = async id => {
    ids.push(id);
    const item = responses[Math.min(ids.length - 1, responses.length - 1)];
    if (item instanceof Error) throw item;
    return item;
  };
  return { client, ids, trace, options: { interval: 0.001, timeout: 1, onQuery: item => trace.push(item) },
    submits: () => submits };
}

(async () => {
  for (const missing of [
    { code: 10106, message: "任务不存在" },
    { code: 0, data: { error_code: 10106, error_msg: "任务不存在" } },
    Object.assign(new WinkError("任务不存在"), { extCode: 10106 }),
  ]) {
    const test = fixture([missing, missing, completed]);
    assert.strictEqual(await test.client.run("https://example.test/input.mp4", test.options), completed);
    assert.strictEqual(test.submits(), 1, "query retries must never resubmit");
    assert.deepStrictEqual(test.ids, Array(3).fill("accepted-task"));
    assert.strictEqual(test.trace.filter(row => row.event === "query_retry").length, 2);
    assert.strictEqual(test.trace.at(-1).event, "task_success");
  }
  // Bound transient visibility retries to 30s, independent of a long task timeout.
  const realNow = Date.now;
  try {
    let clock = realNow();
    Date.now = () => clock;
    const test = fixture([{ code: 10106 }]);
    const query = test.client.query;
    test.client.query = async id => { clock += 15000; return query(id); };
    await assert.rejects(test.client.run("https://example.test/input.mp4", { ...test.options, timeout: 120 }),
      error => error.queryUnresolved === true && error.extCode === 10106);
    assert.strictEqual(test.ids.length, 2);
    assert.strictEqual(test.submits(), 1);
  } finally { Date.now = realNow; }

  const timedOut = fixture([{ code: 10106 }]);
  const before = Date.now();
  await assert.rejects(timedOut.client.run("https://example.test/input.mp4", { ...timedOut.options, interval: 10, timeout: 0.005 }),
    error => error.queryUnresolved === true && error.message.includes("处理结果尚未确认"));
  assert.ok(Date.now() - before < 1000, "retry sleep must be clamped to the task timeout");
  assert.strictEqual(timedOut.submits(), 1);

  // Genuine algorithm failures and unrelated query errors must remain terminal.
  for (const terminal of [
    { code: 0, data: { result: { error_code: 10106, error_msg: "algorithm failure" } } },
    { code: 20001, message: "authorization failed" },
  ]) {
    const test = fixture([terminal]);
    assert.strictEqual(await test.client.run("https://example.test/input.mp4", test.options), terminal);
    assert.strictEqual(test.ids.length, 1);
  }
  const known = fixture([{ code: 0, data: { result: { error_code: 29901 } } }, { code: 10106 }]);
  await assert.rejects(known.client.run("https://example.test/input.mp4", known.options), error => error.queryUnresolved);
  assert.strictEqual(known.ids.length, 2, "only the initial visibility window is retryable");

  // Verify CLI consumers can distinguish an accepted task with unknown state.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wink-visibility-"));
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let output = "";
  try {
    const input = path.join(directory, "input.mp4");
    fs.writeFileSync(input, "mock-video");
    const test = fixture([{ code: 10106 }]);
    test.client.withApiKey = () => test.client;
    test.client.aiTypeConfig = async () => ({ code: 0, data: [{ type: 11, content_type: 2, name: "视频超清" }] });
    test.client.uploadFile = async (_file, options) => { options.onProgress(1); return { resource_url: "https://example.test/upload.mp4" }; };
    process.stdout.write = chunk => { output += chunk; return true; };
    process.stderr.write = () => true;
    const code = await main(["picture_quality", "--input", input, "--api-key", "offline-fixture",
      "--interval", "0.001", "--timeout", "0.005", "--json"], {
      createClient: () => test.client,
      probeMedia: () => ({ width: 320, height: 240, duration: 10, size: 10 }),
    });
    assert.strictEqual(code, 3);
    const result = JSON.parse(output).results[0];
    assert.strictEqual(result.task_id, "accepted-task");
    assert.strictEqual(result.task_submitted, true);
    assert.strictEqual(result.task_state, "unknown");
    assert.strictEqual(result.failure_stage, "query");
    assert.strictEqual(result.error_code, 10106);
    assert.strictEqual(test.submits(), 1);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("task visibility: same-ID recovery, bounded retry, terminal errors and CLI unknown state passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
