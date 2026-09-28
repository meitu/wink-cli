"use strict";
const assert = require("assert");
const { remainingTime, createFileProgress } = require("../src/cli_progress");

assert.strictEqual(remainingTime(61000), "1分1秒");
assert.strictEqual(remainingTime("120000"), "2分0秒");
assert.strictEqual(remainingTime(1), "0分1秒");
assert.strictEqual(remainingTime(0), "0分0秒");
for (const value of [null, undefined, "", " ", -1, NaN, Infinity, "unknown", false, true, [], {}]) {
  assert.strictEqual(remainingTime(value), null);
}

for (const isTTY of [true, false]) {
  let text = "";
  const reporter = createFileProgress("/path/photo.jpg", { isTTY, write: (chunk) => { text += chunk; } });
  reporter.upload(0);
  reporter.upload(0.0797);
  const before = text;
  reporter.upload(0.0797);
  assert.strictEqual(text, before);
  reporter.upload(1);
  assert.ok(!text.includes("100%"), "bytes sent alone do not confirm successful upload");
  reporter.upload(1, true);
  reporter.processing(61000);
  reporter.processing(undefined);
  reporter.recharge("美豆不足，请充值");
  reporter.recharge("当前美豆 10，等待大于 10");
  reporter.processing();
  reporter.download({ receivedBytes: 5, totalBytes: 10 });
  assert.ok(text.includes("下载中：50%"));
  reporter.download({ receivedBytes: 10, totalBytes: 10 });
  assert.ok(!text.includes("下载中：100%"), "100% waits for successful file save");
  reporter.download({ receivedBytes: 10, totalBytes: 10, done: true });
  if (isTTY) assert.ok(!text.includes("\n"), "changing stages must never start a new line");
  reporter.finish("保存成功");
  const ended = text; reporter.end(); assert.strictEqual(text, ended);
  assert.ok(text.includes("photo.jpg 上传中：8%"));
  assert.ok(text.includes("photo.jpg 处理中：正在处理，预计还需 61 秒"));
  assert.ok(text.includes("photo.jpg 处理中：正在估算剩余时间"));
  assert.ok(text.includes("photo.jpg 等待充值：当前美豆 10，等待大于 10"));
  if (isTTY) {
    assert.strictEqual(text.split("\n").length - 1, 1, "one terminal line for the entire file including completion");
    assert.ok(text.endsWith("photo.jpg 完成：保存成功\n"));
    assert.ok(text.includes("\r\x1b[2K"));
  } else {
    assert.ok(!text.includes("\r") && !text.includes("\x1b"), "redirected output has no terminal escapes");
  }
}
let failure = "";
const failed = createFileProgress("/path/failed.jpg", { isTTY: true, write: (s) => { failure += s; } });
failed.upload(0.5);
failed.processing(1000);
failed.fail("服务端错误");
assert.strictEqual(failure.split("\n").length - 1, 1);
assert.ok(failure.endsWith("failed.jpg 失败：服务端错误\n"));
console.log("cli progress: milliseconds, percentages, terminal refresh, redirected output and success boundaries passed");

// Narrow terminals must keep in-place updates on one row.
let narrow = "";
const fitted = createFileProgress("/Users/lixingping/Downloads/6face-Scene-002.mp4", {
  isTTY: true, columns: 40, write: (s) => { narrow += s; },
});
fitted.processing(0);
assert.ok(!narrow.includes("\n"));
assert.match(narrow, /\r\x1b\[2K6face-Scene-002\.mp4 处理中：.{0,24}…$/);
assert.ok(!narrow.includes("/Users/lixingping"));

// JSON progress stays parseable even on a TTY; time starts only after submit.
let clock = 10000, jsonText = "";
const structured = createFileProgress("/path/photo.jpg", { isTTY: true, write: s => { jsonText += s; } }, { json: true, now: () => clock });
structured.upload(1);
structured.upload(1, true);
structured.recharge("等待充值");
clock += 300000;
structured.processing();
structured.task({ taskId: "task-1", elapsedMs: 0 });
structured.processing(5000);
clock += 2000;
structured.processing("3000");
structured.processing(-1);
structured.processing(0);
clock += 4500;
structured.processing(0);
structured.finish("已完成", "https://example.test/result.jpg");
const messages = jsonText.trim().split("\n").map(line => JSON.parse(line));
assert.ok(messages.every(event => event.type === "progress" && event.file === "/path/photo.jpg"));
assert.strictEqual(messages[0].upload_percent, 99);
assert.strictEqual(messages[1].upload_percent, 100);
assert.ok(messages.slice(0, 4).every(event => event.elapsed_ms === null && event.task_id === null));
assert.strictEqual(messages[4].elapsed_ms, 0);
assert.strictEqual(messages[5].elapsed_ms, 2000);
assert.strictEqual(messages[5].remaining_ms, 3000);
assert.strictEqual(messages[6].remaining_ms, null);
assert.strictEqual(messages[7].phase, "processing");
assert.strictEqual(messages[7].message, "已超过预计时间 0 秒，当前任务可能比较多，请您耐心等待");
assert.strictEqual(messages[8].message, "已超过预计时间 4 秒，当前任务可能比较多，请您耐心等待");
assert.strictEqual(messages.at(-1).phase, "completed");
assert.strictEqual(messages.at(-1).task_id, "task-1");
assert.strictEqual(messages.at(-1).result_url, "https://example.test/result.jpg");
structured.fail("网络错误");
assert.strictEqual(JSON.parse(jsonText.trim().split("\n").at(-1)).remaining_ms, null);

(async () => {
  const { WinkClient } = require("../src/wink_client");
  const client = new WinkClient({ log: () => {} });
  const updates = [];
  client.submit = async () => {
    assert.strictEqual(updates.length, 0, "no task timer before submit succeeds");
    return { code: 0, data: { msg_id: "progress-test" } };
  };
  let queries = 0;
  client.query = async () => ++queries === 1
    ? { code: 0, data: { remaining_elapsed: 0, result: { error_code: 29901 } } }
    : { code: 0, data: { result: { error_code: 0 } } };
  await client.run("https://example.test/input.jpg", { interval: 0.001, onProgress: event => updates.push(event) });
  assert.deepStrictEqual(updates[0], { phase: "running", taskId: "progress-test", elapsedMs: 0, remainingMs: null });
  assert.strictEqual(updates[1].remainingMs, 0);
  assert.strictEqual(updates[1].phase, "running");
  assert.strictEqual(updates[2].phase, "finish");
  assert.ok(updates.every((event, index) => Number.isFinite(event.elapsedMs) && (!index || event.elapsedMs >= updates[index - 1].elapsedMs)));
  client.query = async () => { throw new Error("query failed"); };
  updates.length = 0;
  await assert.rejects(client.run("https://example.test/input.jpg", { onProgress: event => updates.push(event) }), /query failed/);
  assert.strictEqual(updates[0].taskId, "progress-test", "first query failure still exposes submitted task ID");
  console.log("structured progress: task timer, unknown/zero estimates, upload, recharge, completion and failure passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
