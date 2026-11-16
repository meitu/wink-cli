#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function mediaExtension(header) {
  if (header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return ".jpg";
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  const ascii = (start, end) => header.toString("ascii", start, end);
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return ".gif";
  if (ascii(0, 2) === "BM") return ".bmp";
  if (ascii(4, 8) === "ftyp") {
    if (["heic", "heix", "hevc", "hevx", "mif1"].includes(ascii(8, 12))) return ".heic";
    if (["avif", "avis"].includes(ascii(8, 12))) return ".avif";
    return ascii(8, 12) === "qt  " ? ".mov" : ".mp4";
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return ".avi";
  if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return ".mkv";
  throw new Error("结果不是可识别的图片或视频，停止后续步骤");
}

function resultForInput(summary, input) {
  const matched = Array.isArray(summary?.results)
    ? summary.results.filter(row => row && row.file === input) : [];
  if (matched.length !== 1) throw new Error("不能唯一匹配上一步实际输入的结果");
  const row = matched[0];
  if (row.ok !== true || typeof row.result_url !== "string") {
    throw new Error("上一步未成功或缺少结果链接，停止后续步骤");
  }
  const url = new URL(row.result_url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("成功结果必须是无登录信息的 HTTP(S) 链接");
  }
  return row.result_url;
}

async function downloadIntermediate(summary, input, directory, maxBytes = 2 * 1024 ** 3) {
  if (!path.isAbsolute(input) || !path.isAbsolute(directory)) throw new Error("输入和临时目录必须为绝对路径");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("下载上限必须为正整数");
  // Validate the exact per-file outcome before making any network request.
  const url = resultForInput(summary, input);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const owned = await fs.mkdtemp(path.join(directory, "wink-step-"));
  let handle;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`中间结果下载失败（HTTP ${response.status}）`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      await response.body.cancel();
      throw new Error("结果超过下载上限或响应长度无效");
    }
    const partial = path.join(owned, "result.part");
    handle = await fs.open(partial, "wx", 0o600);
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("结果超过下载上限");
      await handle.writeFile(chunk);
    }
    if (declared !== null && bytes !== Number(declared)) throw new Error("中间结果下载不完整");
    const header = Buffer.alloc(64);
    await handle.close();
    handle = await fs.open(partial, "r");
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const extension = mediaExtension(header.subarray(0, bytesRead));
    await handle.close();
    handle = null;
    const file = path.join(owned, "result" + extension);
    await fs.rename(partial, file);
    return { file, bytes };
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(owned, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("node download_intermediate.cjs --result-json <绝对路径> --file <上一步输入绝对路径> --directory <临时目录绝对路径> [--max-bytes <正整数>]\n只下载唯一匹配的成功中间结果，不提交云任务。");
    return;
  }
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--result-json", "--file", "--directory", "--max-bytes"].includes(key)
      || flags[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("参数缺失、重复或不支持；使用 --help 查看用法");
    }
    flags[key] = argv[i + 1];
  }
  if (!["--result-json", "--file", "--directory"].every(k => flags[k])) throw new Error("必须指定汇总 JSON、上一步实际输入和临时目录");
  if (!path.isAbsolute(flags["--result-json"])) throw new Error("汇总 JSON 必须为绝对路径");
  const summary = JSON.parse(await fs.readFile(flags["--result-json"], "utf8"));
  console.log(JSON.stringify(await downloadIntermediate(summary, flags["--file"], flags["--directory"],
    flags["--max-bytes"] === undefined ? undefined : Number(flags["--max-bytes"]))));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // Do not print a signed source URL or a low-level request dump on failure.
  const detail = error instanceof TypeError || error.name === "TimeoutError"
    ? "网络、链接或响应读取失败" : error.message;
  console.error(`${detail}；保留上一步结果，不重新投递。`);
  process.exitCode = 1;
});

module.exports = { resultForInput, mediaExtension, downloadIntermediate };
