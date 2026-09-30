"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runner = path.join(__dirname, "../src/agent_run_progress.js");
const fakeCli = path.join(os.tmpdir(), `wink-fake-cli-${process.pid}.js`);
const patched = path.join(os.tmpdir(), `wink-agent-run-progress-${process.pid}.js`);

function writeFake(events) {
  fs.writeFileSync(fakeCli, `
if (process.argv.includes("--live-progress")) throw new Error("helper flag leaked to CLI");
const events = ${JSON.stringify(events)};
for (const event of events) process.stderr.write(JSON.stringify(event) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, results: [] }) + "\\n");
`);
}

function patchRunner(extraTransform = (s) => s) {
  let src = fs.readFileSync(runner, "utf8").replace(
    'path.join(__dirname, "cli.js")',
    JSON.stringify(fakeCli),
  );
  src = extraTransform(src);
  fs.writeFileSync(patched, src);
}

function run(events, extraArgs = []) {
  writeFake(events);
  patchRunner();
  return spawnSync(process.execPath, [patched, ...extraArgs, "picture_quality", "--input", "/path/6815066-uhd_4096_1974_30fps.mp4"], {
    encoding: "utf8",
    windowsHide: true,
  });
}

{
  const result = run([
    { type: "progress", phase: "uploading", file: "/path/6815066-uhd_4096_1974_30fps.mp4", message: "上传中 10%", upload_percent: 10 },
    { type: "progress", phase: "uploading", file: "/path/6815066-uhd_4096_1974_30fps.mp4", message: "上传中 15%", upload_percent: 15 },
    { type: "progress", phase: "uploading", file: "/path/6815066-uhd_4096_1974_30fps.mp4", message: "上传中 79%", upload_percent: 79 },
    { type: "progress", phase: "processing", file: "/path/6815066-uhd_4096_1974_30fps.mp4", message: "正在处理，预计还需 11 秒", elapsed_ms: 9300, remaining_ms: 11000 },
    { type: "progress", phase: "processing", file: "/path/6815066-uhd_4096_1974_30fps.mp4", message: "正在处理，预计还需 5 秒", elapsed_ms: 15000, remaining_ms: 5000 },
    { type: "progress", phase: "completed", file: "/path/6815066-uhd_4096_1974_30fps.mp4", message: "完成", elapsed_ms: 20000, remaining_ms: 0, result_url: "https://example.test/out.mp4" },
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const err = result.stderr;
  // Prepare line is shown once via WorkBuddy Bash description, not duplicated in LOG.
  assert.ok(!err.includes("正在准备上传素材"), err);
  assert.match(err, /\d+\.\d+s 6815066-uhd_4096_1974_30fps\.mp4 · 上传中 10%/);
  assert.ok(!err.includes("上传中 15%"), "upload mid-bucket skipped");
  assert.match(err, /\d+\.\d+s 6815066-uhd_4096_1974_30fps\.mp4 · 上传中 79%/);
  assert.ok(err.includes("9.3s 6815066-uhd_4096_1974_30fps.mp4 · 正在处理"), err);
  assert.ok(err.includes("预计还需 11 秒"), "short jobs show the real ETA once");
  assert.ok(!err.includes("预计还需 5 秒"), "short jobs do not repeatedly update");
  assert.ok(err.includes("20.0s 6815066-uhd_4096_1974_30fps.mp4 · 完成"), err);
  assert.ok(!err.includes("[阶段]") && !err.includes("[完成]"), err);
  assert.ok(!err.includes("█"), err);
  // Per-file completion must not inject a second, provisional JSON document.
  assert.deepStrictEqual(JSON.parse(result.stdout), { ok: true, results: [] });
}

{
  // Short-job "once" plan must still surface overdue so the timeline and watch stay alive.
  writeFake([
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 11 秒", elapsed_ms: 0, remaining_ms: 11000 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 5 秒", elapsed_ms: 6000, remaining_ms: 5000 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "已超过预计时间 0 秒，当前任务可能比较多，请您耐心等待", elapsed_ms: 12000, remaining_ms: 0 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "已超过预计时间 4 秒，当前任务可能比较多，请您耐心等待", elapsed_ms: 16000, remaining_ms: 0 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "已超过预计时间 54 秒，当前任务可能比较多，请您耐心等待", elapsed_ms: 66000, remaining_ms: 0 },
    { type: "progress", phase: "completed", file: "/path/clip.mp4", message: "完成", elapsed_ms: 70000, remaining_ms: 0 },
  ]);
  patchRunner((src) => src
    .replace("const startedAt = Date.now();", "let __now = 0; Date.now = () => __now; const startedAt = 0;")
    .replace("showEvent(event);", "if (Number.isFinite(event.elapsed_ms)) __now = event.elapsed_ms; showEvent(event);"));
  const result = spawnSync(process.execPath, [patched, "picture_quality", "--input", "/path/clip.mp4"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes("0.0s clip.mp4 · 正在处理，预计还需 11 秒"), result.stderr);
  assert.ok(!result.stderr.includes("预计还需 5 秒"), "once mode still suppresses mid-ETA");
  assert.ok(result.stderr.includes("12.0s clip.mp4 · 已超过预计时间 0 秒"), result.stderr);
  assert.ok(!result.stderr.includes("已超过预计时间 4 秒"), "overdue follows 50s interval after first");
  assert.ok(result.stderr.includes("66.0s clip.mp4 · 已超过预计时间 54 秒"), result.stderr);
  assert.ok(result.stderr.includes("70.0s clip.mp4 · 完成"), result.stderr);
}

{
  writeFake([
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 600 秒", elapsed_ms: 0, remaining_ms: 600000 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 550 秒", elapsed_ms: 50000, remaining_ms: 550000 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 500 秒", elapsed_ms: 100000, remaining_ms: 500000 },
    { type: "progress", phase: "completed", file: "/path/clip.mp4", message: "完成", elapsed_ms: 600000, remaining_ms: 0 },
  ]);
  patchRunner((src) => src
    .replace("const startedAt = Date.now();", "let __now = 0; Date.now = () => __now; const startedAt = 0;")
    .replace("showEvent(event);", "if (Number.isFinite(event.elapsed_ms)) __now = event.elapsed_ms; showEvent(event);"));
  const result = spawnSync(process.execPath, [patched, "picture_quality", "--input", "/path/clip.mp4"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes("0.0s clip.mp4 · 正在处理，预计还需 600 秒"), result.stderr);
  assert.ok(result.stderr.includes("50.0s clip.mp4 · 正在处理，预计还需 550 秒"), result.stderr);
  assert.ok(result.stderr.includes("100.0s clip.mp4 · 正在处理，预计还需 500 秒"), result.stderr);
  assert.ok(result.stderr.includes("600.0s clip.mp4 · 完成"), result.stderr);
}

{
  // Long-job ETA held in pending must NOT flush right before 完成.
  writeFake([
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 200 秒", elapsed_ms: 0, remaining_ms: 200000 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 180 秒", elapsed_ms: 5000, remaining_ms: 180000 },
    { type: "progress", phase: "completed", file: "/path/clip.mp4", message: "完成", elapsed_ms: 8000, remaining_ms: 0 },
  ]);
  patchRunner((src) => src
    .replace("const startedAt = Date.now();", "let __now = 0; Date.now = () => __now; const startedAt = 0;")
    .replace("showEvent(event);", "if (Number.isFinite(event.elapsed_ms)) __now = event.elapsed_ms; showEvent(event);"));
  const result = spawnSync(process.execPath, [patched, "picture_quality", "--input", "/path/clip.mp4"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes("0.0s clip.mp4 · 正在处理，预计还需 200 秒"), result.stderr);
  assert.ok(!result.stderr.includes("预计还需 180 秒"), "pending ETA must not flush on complete");
  assert.ok(result.stderr.includes("8.0s clip.mp4 · 完成"), result.stderr);
  const completeIdx = result.stderr.lastIndexOf("· 完成");
  const etaIdx = result.stderr.lastIndexOf("预计还需");
  assert.ok(completeIdx > etaIdx, "完成 must be the last status line");
}

{
  const result = run([
    { type: "progress", phase: "uploading", file: "/path/clip.mp4", upload_percent: 10 },
    { type: "progress", phase: "uploading", file: "/path/clip.mp4", upload_percent: 15 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 11 秒", elapsed_ms: 9000, remaining_ms: 11000 },
    { type: "progress", phase: "processing", file: "/path/clip.mp4", message: "正在处理，预计还需 5 秒", elapsed_ms: 15000, remaining_ms: 5000 },
    { type: "progress", phase: "completed", file: "/path/clip.mp4", elapsed_ms: 18000 },
  ], ["--live-progress"]);
  assert.strictEqual(result.status, 0, result.stderr);
  for (const message of ["上传中 10%", "上传中 15%", "预计还需 11 秒", "预计还需 5 秒", "· 完成"]) {
    assert.ok(result.stderr.includes(message), result.stderr);
  }
  assert.deepStrictEqual(JSON.parse(result.stdout), { ok: true, results: [] });
}


// Initial R fixes the schedule: include the first display, exclude completion.
for (const [seconds, interval, count] of [[11, Infinity, 1], [100, 10, 10], [200, 20, 10], [500, 50, 10], [600, 50, 12]]) {
  const events = [{ type: "progress", phase: "processing", file: "/path/cadence.mp4", elapsed_ms: 0, remaining_ms: null, message: "正在估算剩余时间" }];
  for (let t = 0; t < seconds; t++) events.push({ type: "progress", phase: "processing", file: "/path/cadence.mp4", elapsed_ms: t * 1000, remaining_ms: (seconds - t) * 1000, message: `正在处理，预计还需 ${seconds - t} 秒` });
  events.push({ type: "progress", phase: "completed", file: "/path/cadence.mp4", elapsed_ms: seconds * 1000 });
  writeFake(events);
  patchRunner(src => src.replace("const startedAt = Date.now();", "let __now = 0; Date.now = () => __now; const startedAt = 0;").replace("showEvent(event);", "if (Number.isFinite(event.elapsed_ms)) __now = event.elapsed_ms; showEvent(event);"));
  const result = spawnSync(process.execPath, [patched, "picture_quality"], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  const lines = result.stderr.split("\n").filter(line => line.includes(" · 正在处理，预计还需"));
  assert.strictEqual(lines.length, count, `R=${seconds}: ${lines.join("\n")}`);
  lines.forEach((line, index) => assert.ok(line.startsWith(`${(index === 0 ? 0 : index * interval).toFixed(1)}s `), line));
}

fs.unlinkSync(fakeCli);
fs.unlinkSync(patched);
console.log("agent_run_progress: screenshot plain-text format passed");
