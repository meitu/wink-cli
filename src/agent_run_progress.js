#!/usr/bin/env node
"use strict";

/**
 * Agent helper: run wink-cli once and relay --progress-json as a single TTY line.
 * Keeps WorkBuddy timelines to one tool step instead of poll + TaskUpdate spam.
 *
 * Usage:
 *   node scripts/agent_run_progress.js <cli-args...>
 * Example:
 *   node scripts/agent_run_progress.js video_repair --level 2 --input "/abs/path.mp4"
 */
const { spawn } = require("child_process");
const path = require("path");

const cliEntry = path.join(__dirname, "cli.js");
const args = process.argv.slice(2);
if (!args.length) {
  process.stderr.write("用法: node scripts/agent_run_progress.js <wink-cli 参数...>\n");
  process.exit(2);
}
if (!args.includes("--json")) args.push("--json");
if (!args.includes("--progress-json")) args.push("--progress-json");

const child = spawn(process.execPath, [cliEntry, ...args], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let stdout = "";
let stderrBuf = "";
let lastMessage = "";
let sawRecharge = false;

function showProgress(message, { forceNewline = false } = {}) {
  if (!message || (message === lastMessage && !forceNewline)) return;
  lastMessage = message;
  if (forceNewline) process.stderr.write(`\n${message}\n`);
  else process.stderr.write(`\r\x1b[2K${message}`);
}

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});

child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString("utf8");
  let newline;
  while ((newline = stderrBuf.indexOf("\n")) >= 0) {
    const line = stderrBuf.slice(0, newline);
    stderrBuf = stderrBuf.slice(newline + 1);
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (!event || event.type !== "progress") {
        process.stderr.write(`${line}\n`);
        continue;
      }
      const message = typeof event.message === "string" ? event.message : "";
      if (event.phase === "waiting_recharge") {
        sawRecharge = true;
        showProgress(message, { forceNewline: true });
      } else {
        showProgress(message);
      }
    } catch {
      process.stderr.write(`${line}\n`);
    }
  }
});

child.on("error", (error) => {
  process.stderr.write(`\n启动失败: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (lastMessage && !sawRecharge) process.stderr.write("\n");
  if (stdout) process.stdout.write(stdout);
  if (signal) {
    process.stderr.write(`进程被信号中断: ${signal}\n`);
    process.exit(1);
  }
  process.exit(code == null ? 1 : code);
});
