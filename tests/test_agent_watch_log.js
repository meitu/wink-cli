"use strict";

const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const watcher = path.join(__dirname, "../src/agent_watch_log.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-watch-"));
const logPath = path.join(dir, "progress.log");
const stdoutPath = `${logPath}.stdout`;

function waitExit(child, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, ms);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function main() {
  fs.writeFileSync(logPath, "正在准备上传素材\n");
  const child = spawn(process.execPath, [watcher, logPath, ""], { encoding: "utf8" });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  setTimeout(() => {
    fs.appendFileSync(logPath, "3.0s clip.mp4 · 上传中 40%\n__TRACE__ {}\n");
  }, 200);
  await waitExit(child);
  assert.strictEqual(out.trim(), "3.0s clip.mp4 · 上传中 40%");

  fs.writeFileSync(logPath, "10.0s clip.mp4 · 正在处理，预计还需 20 秒\n12.0s clip.mp4 · 完成\n");
  fs.writeFileSync(stdoutPath, JSON.stringify({
    ok: true, total: 1, succeeded: 1, failed: 0,
    results: [{ file: "/path/clip.mp4", ok: true, result_url: "https://example.test/out.mp4" }],
  }) + "\n");
  const result = spawnSync(process.execPath, [watcher, logPath, "10.0s clip.mp4 · 正在处理，预计还需 20 秒"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("__DONE__\n"), result.stdout);
  assert.ok(result.stdout.includes("12.0s clip.mp4 · 完成"), result.stdout);
  assert.ok(result.stdout.includes("__DELIVER__\n"), result.stdout);
  assert.ok(result.stdout.includes("查看优化后素材"), result.stdout);
  assert.ok(result.stdout.includes("__JSON__\n"), result.stdout);
  assert.ok(result.stdout.includes('"ok":true'), result.stdout);

  // "· 完成" must not bounce back as a progress line (that cost ~28s model turn).
  fs.writeFileSync(logPath, "10.0s clip.mp4 · 正在处理\n12.0s clip.mp4 · 完成\n");
  if (fs.existsSync(stdoutPath)) fs.unlinkSync(stdoutPath);
  const waitDone = spawn(process.execPath, [watcher, logPath, "10.0s clip.mp4 · 正在处理"], { encoding: "utf8" });
  let doneOut = "";
  waitDone.stdout.on("data", (c) => { doneOut += c; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.strictEqual(doneOut, "", `should still be waiting, got: ${doneOut}`);
  fs.writeFileSync(stdoutPath, JSON.stringify({
    ok: true, total: 1, succeeded: 1, failed: 0,
    results: [{ file: "/path/clip.mp4", ok: true, result_url: "https://example.test/out2.mp4" }],
  }) + "\n");
  await waitExit(waitDone);
  assert.ok(doneOut.startsWith("__DONE__\n"), doneOut);
  assert.ok(doneOut.includes("out2.mp4"), doneOut);

  // --until-done must ignore intermediate progress and only return __DONE__.
  fs.writeFileSync(logPath, "正在准备上传素材\n");
  if (fs.existsSync(stdoutPath)) fs.unlinkSync(stdoutPath);
  const until = spawn(process.execPath, [watcher, "--until-done", logPath], { encoding: "utf8" });
  let untilOut = "";
  until.stdout.on("data", (c) => { untilOut += c; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.appendFileSync(logPath, "3.0s clip.mp4 · 上传中 40%\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(untilOut, "", `until-done should ignore progress, got: ${untilOut}`);
  fs.appendFileSync(logPath, "8.0s clip.mp4 · 完成\n");
  fs.writeFileSync(stdoutPath, JSON.stringify({
    ok: true, total: 1, succeeded: 1, failed: 0,
    results: [{ file: "/path/clip.mp4", ok: true, result_url: "https://example.test/until.mp4" }],
  }) + "\n");
  await waitExit(until);
  assert.ok(untilOut.startsWith("__DONE__\n"), untilOut);
  assert.ok(untilOut.includes("until.mp4"), untilOut);


  // Chunked output must not complete before a valid, complete batch is available.
  fs.writeFileSync(stdoutPath, '{"ok":true,"total":2,');
  const partial = spawn(process.execPath, [watcher, "--until-done", "--compact", logPath]);
  let partialOut = "";
  partial.stdout.on("data", c => { partialOut += c; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.strictEqual(partialOut, "", "partial JSON must keep waiting");
  // Old provisional summaries must not cause an early batch success either.
  fs.writeFileSync(stdoutPath, JSON.stringify({ ok: true, results: [
    { file: "first.mp4", ok: true, result_url: "https://example.test/first.mp4" },
  ] }));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.strictEqual(partialOut, "", "single-file provisional output must keep waiting");
  fs.writeFileSync(stdoutPath, JSON.stringify({ ok: false, total: 2, succeeded: 1, failed: 1, results: [
    { file: "first.mp4", ok: true, result_url: "https://example.test/first.mp4" },
    { file: "second.mp4", ok: false, reason: "处理失败" },
  ] }));
  await waitExit(partial);
  assert.match(partialOut, /成功 1 \/ 失败 1 \/ 共 2/);
  assert.match(partialOut, /first.mp4.*查看优化后素材/);
  assert.match(partialOut, /second.mp4 · 失败/);
  assert.ok(!partialOut.includes("__JSON__"), "compact delivery must omit duplicate JSON");

  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(logPath, '__RUNNER_EXIT__ {"code":1}\n');
  const failed = spawnSync(process.execPath, [watcher, "--until-done", logPath], { encoding: "utf8", timeout: 3000 });
  assert.strictEqual(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /__ERROR__/);
  assert.ok(!failed.stdout.includes("__DONE__"));

  // A fresh normal watch gives completion priority over an unseen progress row.
  fs.writeFileSync(logPath, "5.0s clip.mp4 · 正在处理，预计还需 20 秒\n__TRACE__ {}\n");
  fs.writeFileSync(stdoutPath, JSON.stringify({ ok: true, total: 1, succeeded: 1, failed: 0,
    results: [{ file: "clip.mp4", ok: true, result_url: "https://example.test/priority.mp4" }] }));
  const priority = spawnSync(process.execPath, [watcher, "--compact", logPath], { encoding: "utf8", timeout: 3000 });
  assert.ok(priority.stdout.startsWith("__DONE__\n"));
  assert.ok(!priority.stdout.includes("预计还需"));

  // Large batches must drain fully to a pipe before the watcher exits.
  const results = Array.from({ length: 1000 }, (_, i) => ({ file: `${i}.mp4`, ok: true, result_url: `https://example.test/${i}.mp4` }));
  fs.writeFileSync(stdoutPath, JSON.stringify({ ok: true, total: results.length, succeeded: results.length, failed: 0, results }));
  const large = spawnSync(process.execPath, [watcher, "--until-done", logPath], { encoding: "utf8", timeout: 3000 });
  assert.strictEqual(large.status, 0, large.stderr);
  assert.strictEqual(JSON.parse(large.stdout.split("__JSON__\n")[1]).results.length, 1000);


  // Streaming mode keeps one tool call alive: real text updates and immediate result.
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(logPath, '3.0s clip.mp4 · 上传中 40%\n__TRACE__ {"event":"query_start"}\n');
  const streaming = spawn(process.execPath, [watcher, "--until-done", "--stream-progress", "--compact", logPath]);
  let streamed = "";
  streaming.stdout.on("data", c => { streamed += c; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(streamed, /上传中 40%/);
  assert.strictEqual(streaming.exitCode, null);
  fs.appendFileSync(logPath, '4.0s clip.mp4 · 正在处理，预计还需 20 秒\n__TRACE__ {"event":"query_response"}\n');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(streamed, /预计还需 20 秒/);
  fs.appendFileSync(logPath, '5.0s clip.mp4 · 正在处理，预计还需 19 秒\n');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(!streamed.includes("预计还需 19 秒"), "processing output is throttled");
  fs.writeFileSync(stdoutPath, JSON.stringify({ ok: true, total: 1, succeeded: 1, failed: 0,
    results: [{ file: "clip.mp4", ok: true, result_url: "https://example.test/live.mp4" }] }));
  await waitExit(streaming, 1000);
  assert.match(streamed, /__DONE__/);
  assert.match(streamed, /live.mp4/);
  assert.ok(!streamed.includes("__TRACE__"));
  assert.ok(!streamed.includes("预计还需 19 秒"), "completion must drop stale pending progress");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("agent_watch_log: passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
