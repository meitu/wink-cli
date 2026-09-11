"use strict";
const assert = require("assert");
const { remainingTime, createFileProgress } = require("../src/cli_progress");

assert.strictEqual(remainingTime(61000), "1分1秒");
assert.strictEqual(remainingTime("120000"), "2分0秒");
assert.strictEqual(remainingTime(1), "0分1秒");
assert.strictEqual(remainingTime(0), "0分0秒");
for (const value of [null, undefined, "", " ", -1, NaN, Infinity, "unknown"]) {
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
  assert.ok(text.includes("/path/photo.jpg 上传中：8%"));
  assert.ok(text.includes("/path/photo.jpg 处理中：剩余1分1秒"));
  assert.ok(text.includes("/path/photo.jpg 处理中：剩余时间估算中"));
  assert.ok(text.includes("/path/photo.jpg 等待充值：当前美豆 10，等待大于 10"));
  if (isTTY) {
    assert.strictEqual(text.split("\n").length - 1, 1, "one terminal line for the entire file including completion");
    assert.ok(text.endsWith("/path/photo.jpg 完成：保存成功\n"));
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
assert.ok(failure.endsWith("/path/failed.jpg 失败：服务端错误\n"));
console.log("cli progress: milliseconds, percentages, terminal refresh, redirected output and success boundaries passed");
