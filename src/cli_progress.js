"use strict";

const path = require("path");

function remainingTime(milliseconds) {
  if (typeof milliseconds !== "number" && typeof milliseconds !== "string") return null;
  if (milliseconds == null || String(milliseconds).trim() === "") return null;
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return null;
  const seconds = Math.ceil(value / 1000);
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** One updating line per file on a terminal; readable lines when redirected. */
function createFileProgress(file, stream = process.stderr, { json = false, now = () => performance.now() } = {}) {
  const label = path.basename(file) || file;
  let last = "", openLine = false;
  let taskId = null, taskStarted = null, overdueStarted = null;
  function emit(phase, detail, fields = {}) {
    const event = { type: "progress", file, phase, task_id: taskId,
      elapsed_ms: taskStarted == null ? null : Math.max(0, Math.round(now() - taskStarted)),
      remaining_ms: null, ...fields, message: detail };
    const line = JSON.stringify(event);
    if (line !== last) stream.write(line + "\n");
    last = line;
  }
  function end() {
    if (openLine) stream.write("\n");
    openLine = false;
  }
  // Keep in-place updates on one terminal row; long final lines may wrap after a newline.
  function show(nextStage, detail, { final = false } = {}) {
    let line = `${label} ${nextStage}：${detail}`;
    if (line === last) return;
    if (stream.isTTY) {
      const width = Math.max(2, Number(stream.columns) || 80);
      if (!final && line.length >= width) line = `${line.slice(0, width - 1)}…`;
      stream.write(`\r\x1b[2K${line}`);
      openLine = true;
    } else {
      stream.write(line + "\n");
    }
    last = line;
  }
  function percent(value, done) {
    if (done) return "100%";
    if (!Number.isFinite(value)) return "进度计算中";
    // 100% is emitted only after the operation succeeds, including saving the download.
    return `${Math.max(0, Math.min(99, Math.round(value * 100)))}%`;
  }
  return {
    task({ taskId: id, elapsedMs }) {
      if (id) taskId = id;
      if (taskStarted == null && Number.isFinite(elapsedMs) && elapsedMs >= 0) taskStarted = now() - elapsedMs;
    },
    upload(value, done = false) {
      const detail = percent(value, done);
      // JSON message includes the stage label so Agent hosts can relay it as-is.
      if (json) emit("uploading", `上传中 ${detail}`, { upload_percent: done ? 100 : Number.isFinite(value) ? Math.max(0, Math.min(99, Math.round(value * 100))) : null });
      else show("上传中", detail);
    },
    processing(milliseconds) {
      const time = remainingTime(milliseconds);
      let detail;
      if (time == null) {
        overdueStarted = null;
        detail = "正在估算剩余时间";
      } else if (Number(milliseconds) === 0) {
        if (overdueStarted == null) overdueStarted = now();
        const overdueSeconds = Math.floor(Math.max(0, now() - overdueStarted) / 1000);
        detail = `已超过预计时间 ${overdueSeconds} 秒，当前任务可能比较多，请您耐心等待`;
      } else {
        overdueStarted = null;
        detail = `正在处理，预计还需 ${Math.ceil(Number(milliseconds) / 1000)} 秒`;
      }
      if (json) emit("processing", detail, { remaining_ms: time == null ? null : Number(milliseconds) });
      else show("处理中", detail);
    },
    recharge(detail) { if (json) emit("waiting_recharge", detail); else show("等待充值", detail); },
    download({ receivedBytes = 0, totalBytes = null, done = false } = {}) {
      show("下载中", percent(totalBytes > 0 ? receivedBytes / totalBytes : NaN, done));
    },
    finish(detail, resultUrl) {
      if (json) emit("completed", detail, { remaining_ms: 0, ...(resultUrl ? { result_url: resultUrl } : {}) });
      else { show("完成", detail, { final: true }); end(); }
    },
    fail(detail) { if (json) emit("failed", detail); else { show("失败", detail, { final: true }); end(); } },
    end,
  };
}

module.exports = { remainingTime, createFileProgress };
