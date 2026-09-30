"use strict";

// Exercise the real runner + watcher through redirected files. No cloud calls.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-delivery-"));
const watcher = path.resolve(__dirname, "../src/agent_watch_log.js");
fs.copyFileSync(path.resolve(__dirname, "../src/agent_run_progress.js"), path.join(dir, "runner.js"));
const processes = [];
function capture(child) {
  processes.push(child);
  let out = "";
  child.stdout?.on("data", chunk => { out += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("delivery timeout")); }, 5000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", reject);
  });
}
async function run(fixture, name) {
  fs.writeFileSync(path.join(dir, "cli.js"), fixture);
  const log = path.join(dir, name);
  const outFd = fs.openSync(`${log}.stdout`, "w");
  const errFd = fs.openSync(log, "w");
  const runner = spawn(process.execPath, [path.join(dir, "runner.js"), "denoise"], { stdio: ["ignore", outFd, errFd] });
  fs.closeSync(outFd); fs.closeSync(errFd);
  const ended = capture(runner);
  const waiting = capture(spawn(process.execPath, [watcher, "--until-done", "--compact", log]));
  return { runner, ended, waiting };
}
(async () => {
  const success = await run(`
const fs = require('fs');
const first = { file: '一.mp4', ok: true, result_url: 'https://example.test/one.mp4' };
process.stderr.write(JSON.stringify({ type: 'progress', phase: 'completed', ...first }) + '\\n');
setTimeout(() => {
  const second = { file: '二.mp4', ok: false, reason: '任务失败' };
  const data = Buffer.from(JSON.stringify({ ok: false, total: 2, succeeded: 1, failed: 1, results: [first, second] }) + '\\n');
  const split = data.indexOf(Buffer.from('一')) + 1;
  process.stdout.write(data.subarray(0, split));
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(path.join(dir, "ready"))}, String(Date.now()));
    process.stdout.write(data.subarray(split));
    setTimeout(() => process.exit(2), 1500);
  }, 250);
}, 250);
`, "batch.log");
  const result = await success.waiting;
  assert.strictEqual(result.code, 0);
  assert.match(result.out, /成功 1 \/ 失败 1 \/ 共 2/);
  assert.match(result.out, /一.mp4/); assert.match(result.out, /二.mp4 · 失败/);
  assert.ok(!result.out.includes('�'), "UTF-8 split chunks must be preserved");
  assert.strictEqual(success.runner.exitCode, null, "delivery must precede child teardown");
  const latency = Date.now() - Number(fs.readFileSync(path.join(dir, "ready"), "utf8"));
  assert.ok(latency < 1000, `unexpected delivery delay: ${latency}ms`);
  assert.strictEqual((await success.ended).code, 2);
  const rows = fs.readFileSync(path.join(dir, "batch.log.timing.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepStrictEqual(rows.map(row => row.event), ["summary_read", "delivery_written"]);
  assert.ok(rows.every(row => Number.isFinite(Date.parse(row.at))));
  const trace = fs.readFileSync(path.join(dir, "batch.log"), "utf8");
  assert.match(trace, /"event":"summary_forwarded"/);
  assert.match(trace, /"event":"file_terminal"/);
  const failure = await run("process.stderr.write('invalid input\\n'); process.exit(1);", "failure.log");
  assert.strictEqual((await failure.waiting).code, 1);
  await failure.ended;
  console.log(`agent_delivery: batch, split JSON/UTF-8, early delivery (${latency}ms), abnormal exit passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of processes) if (child.exitCode === null) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
