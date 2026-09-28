"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runner = path.join(__dirname, "../src/agent_run_progress.js");
const fakeCli = path.join(os.tmpdir(), `wink-fake-cli-${process.pid}.js`);

fs.writeFileSync(fakeCli, `
const events = [
  { type: "progress", phase: "uploading", message: "上传中 10%" },
  { type: "progress", phase: "uploading", message: "上传中 10%" },
  { type: "progress", phase: "processing", message: "正在处理，预计还需 3 秒" },
  { type: "progress", phase: "completed", message: "完成" },
];
for (const event of events) process.stderr.write(JSON.stringify(event) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, results: [] }) + "\\n");
`);

const original = fs.readFileSync(runner, "utf8");
const patched = path.join(os.tmpdir(), `wink-agent-run-progress-${process.pid}.js`);
fs.writeFileSync(patched, original.replace(
  'path.join(__dirname, "cli.js")',
  JSON.stringify(fakeCli),
));

const result = spawnSync(process.execPath, [patched, "picture_quality", "--level", "2"], {
  encoding: "utf8",
  windowsHide: true,
});
assert.strictEqual(result.status, 0, result.stderr);
assert.ok(result.stdout.includes('"ok":true'));
assert.ok(result.stderr.includes("上传中 10%"));
assert.ok(result.stderr.includes("正在处理，预计还需 3 秒"));
assert.strictEqual((result.stderr.match(/上传中 10%/g) || []).length, 1, "duplicate message suppressed");

fs.unlinkSync(fakeCli);
fs.unlinkSync(patched);
console.log("agent_run_progress: single-line relay and final stdout passed");
