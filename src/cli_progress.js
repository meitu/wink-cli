"use strict";

function remainingTime(milliseconds) {
  if (milliseconds == null || String(milliseconds).trim() === "") return null;
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return null;
  const seconds = Math.ceil(value / 1000);
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** One updating line per file on a terminal; readable lines when redirected. */
function createFileProgress(file, stream = process.stderr) {
  let last = "", openLine = false;
  function end() {
    if (openLine) stream.write("\n");
    openLine = false;
  }
  function show(nextStage, detail) {
    const line = `${file} ${nextStage}：${detail}`;
    if (line === last) return;
    if (stream.isTTY) {
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
    upload(value, done = false) { show("上传中", percent(value, done)); },
    processing(milliseconds) {
      const time = remainingTime(milliseconds);
      show("处理中", time == null ? "剩余时间估算中" : `剩余${time}`);
    },
    recharge(detail) { show("等待充值", detail); },
    download({ receivedBytes = 0, totalBytes = null, done = false } = {}) {
      show("下载中", percent(totalBytes > 0 ? receivedBytes / totalBytes : NaN, done));
    },
    finish(detail) { show("完成", detail); end(); },
    fail(detail) { show("失败", detail); end(); },
    end,
  };
}

module.exports = { remainingTime, createFileProgress };
