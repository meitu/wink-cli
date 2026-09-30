#!/usr/bin/env node
"use strict";

/**
 * Agent helper: run wink-cli and relay --progress-json as plain-text lines
 * matching WorkBuddy chat progress copy:
 *   正在准备上传素材
 *   11.2s file.mp4 · 上传中 79%
 *   168.3s file.mp4 · 正在处理，预计还需 262 秒
 *
 * Processing cadence from remaining estimate R (seconds):
 *   ideal = R / 10
 *   - ideal < 10  → emit once
 *   - 10..50      → ~10 updates at interval ideal
 *   - ideal > 50  → interval 50s (~R/50 updates)
 *
 * Usage:
 *   node src/agent_run_progress.js [--live-progress] <cli-args...>
 * --live-progress: relay every upload/processing update for streaming hosts such as Cursor.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 50_000;
const TARGET_UPDATES = 10;
const UPLOAD_PERCENT_STEP = 20;

const cliEntry = path.join(__dirname, "cli.js");
const args = process.argv.slice(2);
let outputFd = 1, errorFd = 2;
const logIndex = args.indexOf("--log");
if (logIndex >= 0) {
  const logPath = args[logIndex + 1];
  if (!logPath || !path.isAbsolute(logPath)) {
    process.stderr.write("--log 必须指定本次任务独立的绝对路径\n");
    process.exit(2);
  }
  args.splice(logIndex, 2);
  let createdLog = false;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    errorFd = fs.openSync(logPath, "wx", 0o600);
    createdLog = true;
    outputFd = fs.openSync(`${logPath}.stdout`, "wx", 0o600);
  } catch (error) {
    if (createdLog) {
      fs.closeSync(errorFd);
      fs.unlinkSync(logPath);
    }
    process.stderr.write(`无法创建本次日志：${error.message}。请使用新的日志路径，未启动上传。\n`);
    process.exit(2);
  }
}
const liveIndex = args.indexOf("--live-progress");
const liveProgress = liveIndex >= 0;
if (liveProgress) args.splice(liveIndex, 1);
if (!args.length) {
  process.stderr.write("用法: node src/agent_run_progress.js <wink-cli 参数...>\n");
  process.exit(2);
}
if (!args.includes("--json")) args.push("--json");
if (!args.includes("--progress-json")) args.push("--progress-json");

const child = spawn(process.execPath, [cliEntry, ...args], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let stdout = "";
let summaryForwarded = false;
let stderrBuf = "";
let lastLine = "";
let lastEmitAt = 0;
let pendingLine = null;
let currentPhase = "";
let processingPlan = null;
let currentFile = "";
let lastUploadBucket = null;
let prepared = false;
const startedAt = Date.now();

function elapsedLabel(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function fileLabel(file) {
  return typeof file === "string" && file ? path.basename(file) : "";
}

function stampFor(event) {
  if (event.phase === "processing" && Number.isFinite(event.elapsed_ms)) {
    return elapsedLabel(event.elapsed_ms);
  }
  if (event.phase === "completed" && Number.isFinite(event.elapsed_ms)) {
    return elapsedLabel(event.elapsed_ms);
  }
  return elapsedLabel(Date.now() - startedAt);
}

function statusBody(event) {
  const message = typeof event.message === "string" ? event.message.trim() : "";
  if (event.phase === "uploading") {
    if (Number.isFinite(event.upload_percent)) {
      return `上传中 ${Math.max(0, Math.min(100, Math.round(event.upload_percent)))}%`;
    }
    return message || "上传中";
  }
  if (event.phase === "processing") {
    return message || "正在处理，正在估算剩余时间";
  }
  if (event.phase === "waiting_recharge") return message || "等待充值";
  if (event.phase === "failed") return message ? `失败：${message}` : "失败";
  if (event.phase === "completed") return "完成";
  return message || "进行中";
}

/** `{time}s {file} · {status}` — same shape as the WorkBuddy progress screenshot. */
function formatLine(event) {
  const base = fileLabel(event.file);
  const body = statusBody(event);
  if (!base) return `${stampFor(event)} ${body}`;
  return `${stampFor(event)} ${base} · ${body}`;
}

function intervalFromRemaining(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
  const remainingSec = remainingMs / 1000;
  const idealSec = remainingSec / TARGET_UPDATES;
  if (idealSec < MIN_INTERVAL_MS / 1000) return { mode: "once", intervalMs: Infinity };
  if (idealSec > MAX_INTERVAL_MS / 1000) return { mode: "interval", intervalMs: MAX_INTERVAL_MS };
  return { mode: "interval", intervalMs: idealSec * 1000 };
}

function writeOut(text) {
  // Make each received chunk visible to file watchers before child teardown.
  fs.writeSync(outputFd, text);
}

function writeErr(text) {
  fs.writeSync(errorFd, text);
}

function emitNow(line) {
  if (!line || line === lastLine) return;
  lastLine = line;
  lastEmitAt = Date.now();
  pendingLine = null;
  writeErr(`${line}\n`);
}

function flushPending() {
  if (pendingLine) emitNow(pendingLine);
}

function writeLine(line, { force = false } = {}) {
  if (!line) return;
  if (force) {
    emitNow(line);
    return;
  }
  if (line === lastLine || line === pendingLine) return;
  pendingLine = line;
}

function emitIfDue(intervalMs) {
  if (pendingLine == null || !Number.isFinite(intervalMs)) return;
  if (Date.now() - lastEmitAt >= intervalMs) emitNow(pendingLine);
}

function ensurePrepared() {
  if (prepared) return;
  prepared = true;
  // Do not emit "正在准备上传素材" here. WorkBuddy already shows it once via
  // the launch Bash `description`; writing the same line to the log made the
  // first poll open a second identical timeline row.
}

function showEvent(event) {
  const phase = event.phase;
  ensurePrepared();

  if (liveProgress && (phase === "uploading" || phase === "processing")) {
    // Streaming hosts can display the real percentage/ETA without the
    // WorkBuddy timeline's upload buckets and short-job ETA suppression.
    writeLine(formatLine(event), { force: true });
    return;
  }

  if (phase === "waiting_recharge") {
    pendingLine = null;
    processingPlan = null;
    writeLine(formatLine(event), { force: true });
    return;
  }
  if (phase === "failed") {
    // Drop any queued ETA — never emit "预计还需" after the job already failed.
    pendingLine = null;
    processingPlan = null;
    writeLine(formatLine(event), { force: true });
    return;
  }
  if (phase === "completed") {
    // Drop any queued ETA — flushing it here used to pin "预计还需 xx 秒"
    // on the WorkBuddy timeline right as the backend finished.
    pendingLine = null;
    processingPlan = null;
    writeLine(formatLine(event), { force: true });
    // A completed event belongs to one file, not the whole batch. Only the
    // CLI's final summary may complete the watcher; stdout is relayed live.
    return;
  }

  const phaseChanged = phase !== currentPhase || (event.file || "") !== currentFile;
  if (phaseChanged) {
    pendingLine = null;
    currentPhase = phase;
    currentFile = event.file || "";
    processingPlan = null;
    lastUploadBucket = null;
  }

  if (phase === "uploading") {
    const percent = Number.isFinite(event.upload_percent) ? Math.round(event.upload_percent) : null;
    const bucket = percent == null ? null : Math.floor(percent / UPLOAD_PERCENT_STEP);
    const line = formatLine(event);
    if (lastUploadBucket == null || percent === 100 || (bucket != null && bucket !== lastUploadBucket)) {
      lastUploadBucket = bucket;
      writeLine(line, { force: true });
    }
    return;
  }

  const line = formatLine(event);
  if (!processingPlan) {
    processingPlan = intervalFromRemaining(event.remaining_ms);
    // The first known estimate fixes this file's cadence; shrinking estimates
    // must not shorten it or suppress the remaining updates midway through.
    if (processingPlan || phaseChanged) writeLine(line, { force: true });
    return;
  }
  if (processingPlan.mode === "once") {
    // Short-job plan only shows the first ETA. Once the backend reports
    // overdue, switch to the max interval so WorkBuddy keeps getting title
    // updates and the host watch does not block until CLI --timeout.
    const overdue = typeof event.message === "string" && event.message.includes("已超过预计时间");
    if (!overdue) return;
    processingPlan = { mode: "interval", intervalMs: MAX_INTERVAL_MS };
    writeLine(line, { force: true });
    return;
  }
  writeLine(line);
  emitIfDue(processingPlan.intervalMs);

}

ensurePrepared();

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stdout += text;
  // Forward immediately so WorkBuddy's "$LOG.stdout" is readable before process exit.
  writeOut(text);
  if (!summaryForwarded) {
    try {
      const data = JSON.parse(stdout);
      if (Array.isArray(data.results) && data.total === data.results.length) {
        summaryForwarded = true;
        writeErr(`__TRACE__ ${JSON.stringify({ event: "summary_forwarded", at: new Date().toISOString(), total: data.total })}\n`);
      }
    } catch { /* Wait for the rest of the JSON document. */ }
  }
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
      if (event?.type === "diagnostic") {
        writeErr(`__TRACE__ ${JSON.stringify(event)}\n`);
        continue;
      }
      if (!event || event.type !== "progress") {
        writeErr(`${line}\n`);
        continue;
      }
      if (["completed", "failed"].includes(event.phase)) {
        writeErr(`__TRACE__ ${JSON.stringify({ event: "file_terminal", at: new Date().toISOString(),
          file: event.file, task_id: event.task_id, phase: event.phase })}\n`);
      }
      showEvent(event);
    } catch {
      writeErr(`${line}\n`);
    }
  }
});

child.on("error", (error) => {
  writeErr(`\n启动失败: ${error.message}\n`);
  writeErr(`__RUNNER_EXIT__ ${JSON.stringify({ code: 1, error: error.message })}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  // Successful result: discard any leftover ETA so WorkBuddy never sticks on
  // "预计还需" after the CLI already finished. Emit a synthetic 完成 if the
  // progress stream somehow missed the completed event.
  if (code === 0 && stdout && !/ · 完成$/.test(lastLine.trim())) {
    pendingLine = null;
    const stamp = elapsedLabel(Date.now() - startedAt);
    emitNow(`${stamp} · 完成`);
  } else {
    pendingLine = null;
  }
  writeErr(`__RUNNER_EXIT__ ${JSON.stringify({ at: new Date().toISOString(), code: code == null ? 1 : code, signal })}\n`);
  if (signal) {
    writeErr(`进程被信号中断: ${signal}\n`);
    process.exit(1);
  }
  process.exit(code == null ? 1 : code);
});
