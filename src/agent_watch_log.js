#!/usr/bin/env node
"use strict";

/**
 * Watch agent_run_progress log until the next progress line or completion.
 *
 * Usage:
 *   node src/agent_watch_log.js [--until-done] [--stream-progress] [--compact] <logPath> [prevLine]
 *
 * --until-done: do not return intermediate progress lines; block until __DONE__.
 *   For hosts that render streamed output. WorkBuddy visible titles use the
 *   ordinary next-progress loop described in the CLI skill.
 *
 * --stream-progress: keep the same wait alive while streaming the latest plain
 * progress (at most every 5s; phase changes immediate). Completion bypasses this
 * cadence and never requires another model/tool turn.
 *
 * Exit stdout:
 *   - next progress line (plain text), or
 *   - __DONE__ / __DELIVER__ / __JSON__ block
 */
const fs = require("fs");
const path = require("path");

const rawArgs = process.argv.slice(2);
const stdoutIndex = rawArgs.indexOf("--stdout");
let explicitStdout;
if (stdoutIndex >= 0) {
  explicitStdout = rawArgs[stdoutIndex + 1];
  if (!explicitStdout || explicitStdout.startsWith("--")) {
    process.stderr.write("--stdout 缺少结果文件路径\n");
    process.exit(2);
  }
  rawArgs.splice(stdoutIndex, 2);
}
const watchStartedAt = Date.now();
const streamProgress = rawArgs.includes("--stream-progress");
const untilDone = rawArgs.includes("--until-done") || streamProgress;
const compact = rawArgs.includes("--compact");
const args = rawArgs.filter(arg => arg !== "--until-done" && arg !== "--compact" && arg !== "--stream-progress");
const logPath = args[0];
const prevLine = args[1] || "";
if (!logPath) {
  process.stderr.write("用法: node agent_watch_log.js [--until-done] [--stream-progress] [--compact] <logPath> [prevLine]\n");
  process.exit(2);
}

const stdoutPath = explicitStdout || `${logPath}.stdout`;
const pollMs = 100;
const prepare = "正在准备上传素材";
let streamedLine = "", streamedStage = "", streamedAt = 0;

function streamLatestProgress() {
  let lines;
  try {
    // Ignore incomplete writes and diagnostic records after the latest progress.
    lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(0, -1);
  } catch { return; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const match = line.match(/^\d+(?:\.\d+)?s (.+) · (上传中|正在|已超过|等待充值|失败|完成)/);
    if (!match) continue;
    const stage = `${match[1]}:${match[2]}`;
    if (line !== streamedLine && (stage !== streamedStage || Date.now() - streamedAt >= 5000)) {
      process.stdout.write(`${line}\n`);
      streamedLine = line;
      streamedStage = stage;
      streamedAt = Date.now();
    }
    return;
  }
}

function readTail(file) {
  try {
    if (!fs.existsSync(file)) return "";
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    return lines.length ? lines[lines.length - 1] : "";
  } catch {
    return "";
  }
}

function isTerminalStatus(line) {
  return typeof line === "string" && (line.includes(" · 完成") || line.includes(" · 失败"));
}

function readCompleteLine() {
  try {
    if (!fs.existsSync(logPath)) return "";
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => isTerminalStatus(line));
    if (lines.length) return lines[lines.length - 1];
    return readTail(logPath);
  } catch {
    return "";
  }
}

function readStdout() {
  try {
    if (!fs.existsSync(stdoutPath)) return "";
    return fs.readFileSync(stdoutPath, "utf8").trim();
  } catch {
    return "";
  }
}

function parseJsonPayload(text) {
  try {
    const data = JSON.parse(text);
    // Require the authoritative batch summary, not a provisional single-file
    // object or a partial write. Counts also protect against incomplete batches.
    if (!data || !Number.isInteger(data.total) || data.total < 1 ||
        !Array.isArray(data.results) || data.results.length !== data.total ||
        !data.results.every(item => item && typeof item.ok === "boolean")) return null;
    const succeeded = data.results.filter(item => item.ok).length;
    if (data.succeeded !== succeeded || data.failed !== data.total - succeeded ||
        data.ok !== (data.failed === 0)) return null;
    return data;
  } catch {
    return null;
  }
}

function formatDeliver(data) {
  if (!data || !Array.isArray(data.results)) return "";
  const lines = [];
  for (const item of data.results) {
    const name = path.basename(item.file || "") || "素材";
    if (item.ok && item.result_url) {
      lines.push(`${name} · 已完成 · [查看优化后素材](${item.result_url})`);
    } else {
      lines.push(`${name} · 失败${item.reason ? ` · ${item.reason}` : ""}`);
    }
  }
  if (!lines.length) return "";
  if (data.results.some(item => item.ok && item.result_url)) {
    lines.push("");
    lines.push("下载链接约 3 小时过期，请尽快下载；过期后可到 [查看最近任务](https://wink.cn/editor/recent-task) 重新获取。");
  }
  return lines.join("\n");
}

function recordTiming(event) {
  const row = { event, at: new Date().toISOString(), watcher_pid: process.pid };
  const text = JSON.stringify(row);
  // A separate sidecar avoids concurrent writes to the runner's stderr log.
  // Diagnostics must not prevent delivery if the directory is read-only.
  try { fs.appendFileSync(`${logPath}.timing.jsonl`, `${text}\n`); } catch {}
  process.stderr.write(`__TIMING__ ${text}\n`);
}

function emitDone(data) {
  recordTiming("summary_read");
  const deliver = formatDeliver(data);
  let output = `__DONE__\n完成: 成功 ${data.succeeded} / 失败 ${data.failed} / 共 ${data.total}\n`;
  if (!compact) output += `${readCompleteLine()}\n`;
  if (deliver) output += `__DELIVER__\n${deliver}\n__END_DELIVER__\n`;
  if (!compact) output += `__JSON__\n${JSON.stringify(data)}\n`;
  // Let Node drain large batches to pipes instead of truncating on process.exit.
  process.stdout.write(output, () => recordTiming("delivery_written"));
}

function runnerExit() {
  try {
    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
    const marker = lines.reverse().find(line => line.startsWith("__RUNNER_EXIT__ "));
    return marker ? JSON.parse(marker.slice("__RUNNER_EXIT__ ".length)) : null;
  } catch {
    return null;
  }
}

function readNextProgress() {
  try {
    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(0, -1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Diagnostics are interleaved after nearly every processing update.
      // Only use a real, complete status line; never replay an older ETA after
      // a terminal line or return an earlier line when the latest was shown.
      if (!/^\d+(?:\.\d+)?s .+ · /.test(line)) continue;
      if (isTerminalStatus(line) || line === prevLine) return "";
      return line;
    }
  } catch { /* The runner may not have created the log yet. */ }
  return "";
}

function tick() {
  const jsonText = readStdout();
  const data = parseJsonPayload(jsonText);
  if (data) {
    emitDone(data);
    return;
  }

  const exited = runnerExit();
  if (exited) {
    // The summary may have been written between our first read and the exit marker.
    const finalData = parseJsonPayload(readStdout());
    if (finalData) emitDone(finalData);
    else {
      process.stdout.write(`__ERROR__\nCLI 已退出但未返回完整结果（code=${exited.code}${exited.signal ? `, signal=${exited.signal}` : ""}）。结果文件 ${stdoutPath} 不存在或不完整。请检查原任务日志和 stdout 重定向路径；非默认路径可用 --stdout 指定，不要自动重新投递。\n`);
      process.exitCode = 1;
    }
    return;
  }

  let logStarted = false;
  try { logStarted = fs.statSync(logPath).size > 0; } catch {}
  if (!logStarted && Date.now() - watchStartedAt >= 10000) {
    process.stdout.write(`__ERROR__\n启动后 10 秒仍未找到有效日志：${logPath}。请检查原后台任务是否启动失败、日志目录及路径；不要自动重新投递。\n`);
    process.exitCode = 1;
    return;
  }

  if (streamProgress) streamLatestProgress();

  if (!untilDone) {
    const line = readNextProgress();
    if (line) {
      process.stdout.write(`${line}\n`);
      return;
    }
  }

  setTimeout(tick, pollMs);
}

tick();
