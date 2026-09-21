#!/usr/bin/env node
"use strict";
/**
 * Wink CLI —— 图片和视频云处理命令行入口。
 *
 * 对外的命令形态与「美图 Wink CLI」一致：
 *   wink-cli                                 显示主帮助
 *   wink-cli --help                          显示主帮助
 *   wink-cli picture_quality --help          显示子命令帮助（含档位表）
 *   wink-cli picture_quality --level 2 --input <路径,路径>
 *
 * 云处理命令及媒体投递类型来自 CF 功能表，详见 cloud_tools.js。
 * 登录后用 /task/ai_type_config 校验当前环境的能力及参数分支。
 *
 * 本文件只做「解析 argv + 编排」，协议细节全部复用 src/wink_client.js，保持单一实现。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openBrowser } = require("./open_browser");
const { imageSize } = require("image-size");
const { readMp4Metadata } = require("./mp4_metadata");
const { createFileProgress } = require("./cli_progress");
const { createRechargeHandler } = require("./beans");
const { fetchBeautyStyles, selectBeautyStyle, buildBeautySubmission, formatBeautyStyles } = require("./ai_beauty");
const {
  WinkClient,
  WinkError,
  responseOk,
  dataObject,
  resultUrl,
  taskState,
  checkAiTypeSupport,
} = require("./wink_client");

const VERSION = require("../package.json").version;
const { ENVIRONMENTS, DEFAULT_ENV, CREDENTIAL_DIR, credentialFile } = require("./runtime_config");
const DEFAULT_LEVEL = 2; // 与参考实现一致：2 = 超清（默认）
const LOGIN_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_SECONDS = 3;
const POLL_TIMEOUT_SECONDS = 600;

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "flv", "wmv", "3gp", "mpeg", "mpg", "ts"]);

// ---------------------------------------------------------------- 档位表

const { COMMANDS, PICTURE_QUALITY_LEVELS, REMOVE_WATERMARK_LEVELS, prepareTool } = require("./cloud_tools");

function levelInfo(level, command = "picture_quality") {
  return COMMANDS[command].levels.find((item) => item.level === Number(level)) || null;
}

function levelRangeText(command = "picture_quality") {
  return COMMANDS[command].levels.map((item) => `${item.level}=${item.name}`).join("，");
}

/**
 * 由档位 + 输入媒体类型解析出 /task/submit 的 type。
 * @throws {WinkError} 档位不存在，或该档位不支持该媒体类型
 */
function taskTypeFor(level, contentType, command = "picture_quality") {
  const info = levelInfo(level, command);
  if (!info) throw new WinkError(`不支持的档位 --level ${level}（可用：${levelRangeText(command)}）`);
  const type = String(contentType) === "1" ? info.image : String(contentType) === "2" ? info.video : null;
  if (!type) {
    const kind = String(contentType) === "1" ? "图片" : "视频";
    throw new WinkError(`档位 ${info.level} ${info.name} 不支持${kind}输入`);
  }
  return { ...info, taskType: type };
}

// ---------------------------------------------------------------- 帮助文案

const MAIN_HELP = [
  "================== 欢迎使用美图wink cli ==================",
  "",
  "用法:",
  "  wink-cli [全局选项] [功能命令] [工具选项]",
  "",
  "全局选项:",
  "  -h, --help                显示帮助（本页或子命令帮助）",
  "",
  "功能命令:",
  ...Object.entries(COMMANDS).map(([command, tool]) => `  ${command.padEnd(24)}${tool.name}（云端工具箱）`),
  "",
  "管理命令:",
  "  login                   授权登录（--open-browser 自动打开浏览器）",
  "  status                  查看本地登录状态",
  "  logout                  退出登录，清理本地凭据",
  "  doctor                  检查环境与版本（支持 --json）",
  "  skill                   读取当前 CLI 的使用说明（支持 --json）",
  "",
  "安装命令:",
  "  install                 安装 CLI 与 Agent 使用 Skill（详见 wink-cli install --help）",
  "",
  "工具选项:",
  "  --level <n>                  档位编号（单档位功能可省略，默认值见子命令帮助）",
  "  --input <path>               输入媒体绝对路径，支持文件夹、视频图片路径（多个以英文“,”号隔开，必填）",
  "",
  "示例:",
  "  wink-cli --help",
  "  wink-cli picture_quality --help",
  "  wink-cli picture_quality --level 2 --input \"D:\\video.mp4\"",
  "  wink-cli picture_quality --level 2 --input \"D:\\videoFolder,D:\\video.mp4\"",
].join("\n");

/** 子命令帮助与命令注册表共用定义；单档位不展示 --level。 */
function toolHelp(command) {
  const tool = COMMANDS[command];
  const lines = [
    `${command} — ${tool.name}（云端工具箱）`,
    "",
    "用法:",
    `  wink-cli ${command} --input <path> [选项]`,
    ...(command === "ai_beauty" ? ["  wink-cli ai_beauty --list-styles [--json]"] : []),
    "",
    ...(tool.levels.length > 1 ? ["档位 (--level):", ...tool.levels.map((item) => `  ${String(item.level).padEnd(4)}${item.name}${item.level === tool.defaultLevel ? "（默认）" : ""}${!item.video ? "  — 仅图片" : !item.image ? "  — 仅视频" : ""}`)] : [`支持媒体: ${tool.levels[0].image ? "图片" : ""}${tool.levels[0].image && tool.levels[0].video ? "、" : ""}${tool.levels[0].video ? "视频" : ""}（自动选择唯一档位）`]),
    "",
    "工具选项:",
    ...(tool.levels.length > 1 ? ["  --level <n>                  档位编号（默认 " + tool.defaultLevel + "）"] : []),
    `  --input <path>               输入媒体绝对路径，支持文件夹、视频图片路径（多个以英文“,”号隔开，${command === "ai_beauty" ? "处理时必填，查询风格无需填写" : "必填"}）`,
    "",
    ...(tool.options || []).map(line => "  " + line),
    "",
    "示例:",
    ...(command === "ai_beauty" ? [
      "  wink-cli ai_beauty -gender male --input \"D:\\video.mp4\"",
      "  wink-cli ai_beauty --gender female --input \"D:\\photo.jpg\"",
      "  wink-cli ai_beauty --list-styles",
      "  wink-cli ai_beauty --style <列表中的物料ID> --input \"D:\\video.mp4\"",
    ] : []),
    `  wink-cli ${command}${tool.levels.length > 1 ? ` --level ${tool.defaultLevel}` : ""} --input "D:\\${tool.levels[0].video ? "video.mp4" : "photo.jpg"}"${tool.example ? " " + tool.example : ""}`,
    "",
    "其他选项:",
    "  --api-key <key>              指定 Wink api_key（默认取 WINK_CLI_API_KEY 环境变量或本地登录缓存）",
    "  --force                      兼容旧命令，已忽略；不再下载文件",
    "  --interval <n>               轮询间隔秒数，默认 " + POLL_INTERVAL_SECONDS,
    "  --timeout <n>                单任务超时秒数，默认 " + POLL_TIMEOUT_SECONDS,
    "  --base-url <url>             自定义联调地址；上传使用正式通道",
    "  --relogin                    忽略本地缓存，重新走 SSO 授权登录",
    "  --json                       以 JSON 输出结果汇总（进度信息走 stderr）",
    "  -h, --help                   显示本帮助",
    "",
    "默认值:",
    "  结果: 仅显示下载链接，不自动下载",
  ];
  return lines.join("\n");
}

function pictureQualityHelp() { return toolHelp("picture_quality"); }

// ---------------------------------------------------------------- argv 解析

/**
 * 极简 argv 解析：支持 `--key value` / `--key=value` / 布尔 `--flag` / `-h`，以及 `-gender` 别名。
 * 返回值形如 { _: ["picture_quality"], flags: { level: "2", input: "a,b" } }。
 */
function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]).replace(/^-gender(?==|$)/, "--gender");
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith("-")) {
        flags[key] = String(next);
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      flags[token.slice(1)] = true;
      continue;
    }
    positional.push(token);
  }
  return { _: positional, flags };
}

/** 取选项值；未提供、或只写了 `--flag`（值为 true）时返回 undefined。 */
function optionValue(flags, ...names) {
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined && value !== true) return String(value);
  }
  return undefined;
}

function optionFlag(flags, ...names) {
  return names.some((name) => flags[name] === true);
}

function resolveEnvironment(flags) {
  const env = flags.env === undefined ? DEFAULT_ENV : flags.env;
  if (typeof env !== "string" || !Object.hasOwn(ENVIRONMENTS, env)) {
    throw new WinkError("--env 必须指定 pre、beta 或 release，默认 release");
  }
  if (flags.test !== undefined || flags["no-test"] !== undefined) {
    throw new WinkError("请使用 --env 选择环境；仅 pre 使用测试上传通道，--test / --no-test 已停用");
  }
  if (flags["base-url"] !== undefined && flags.env !== undefined) {
    throw new WinkError("--base-url 与 --env 不能同时使用");
  }
  if (flags["base-url"] !== undefined && !optionValue(flags, "base-url")) {
    throw new WinkError("--base-url 必须指定服务地址");
  }
  return { env, baseUrl: (optionValue(flags, "base-url") || ENVIRONMENTS[env]).replace(/\/$/, ""),
    isTest: env === "pre" };
}

// ---------------------------------------------------------------- 输入收集

function splitInputs(raw) {
  return String(raw)
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function contentTypeOfFile(file) {
  const ext = path.extname(String(file)).toLowerCase().replace(/^\./, "");
  if (VIDEO_EXTS.has(ext)) return "2";
  if (IMAGE_EXTS.has(ext)) return "1";
  return "";
}

function walkDirectory(dir, sink) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // 跳过隐藏文件/目录（.DS_Store 等）
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDirectory(full, sink);
    else if (entry.isFile()) sink(full);
  }
}

/** 把 --input 的若干路径展开成待处理文件清单（目录递归、按扩展名过滤、去重）。 */
function collectInputs(roots) {
  const files = [];
  const seen = new Set();
  const missing = [];
  const skipped = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    let stat = null;
    try {
      stat = fs.statSync(resolved);
    } catch (_) {
      missing.push(root);
      continue;
    }
    const candidates = [];
    if (stat.isDirectory()) walkDirectory(resolved, (file) => candidates.push(file));
    else if (stat.isFile()) candidates.push(resolved);
    for (const file of candidates.sort()) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (contentTypeOfFile(file)) files.push(file);
      else skipped.push(file);
    }
  }
  return { files, missing, skipped };
}

// ---------------------------------------------------------------- 输出与凭据

function defaultOutputDir() {
  if (process.env.WINK_OUTPUT_DIR) return process.env.WINK_OUTPUT_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "Wink");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Wink", "Cache");
  }
  return path.join(home, ".cache", "Wink");
}

/** 结果文件名：<原名>-result<结果扩展名>；同批次/已存在时自动加序号，避免互相覆盖。 */
function uniqueOutputPath(dir, inputFile, remoteUrl, force, used) {
  let ext = ".bin";
  try {
    ext = path.extname(new URL(remoteUrl).pathname) || ".bin";
  } catch (_) { /* 保底 .bin */ }
  const stem = path.parse(inputFile).name;
  let candidate = path.join(dir, `${stem}-result${ext}`);
  if (!force) {
    let index = 1;
    while (used.has(candidate) || fs.existsSync(candidate)) {
      candidate = path.join(dir, `${stem}-result-${index}${ext}`);
      index += 1;
    }
  }
  used.add(candidate);
  return candidate;
}

function readCredential(baseUrl) {
  try {
    return fs.readFileSync(credentialFile(baseUrl), "utf8").trim();
  } catch (_) {
    return "";
  }
}

function writeCredential(apiKey, baseUrl) {
  try {
    fs.mkdirSync(CREDENTIAL_DIR, { recursive: true });
    fs.writeFileSync(credentialFile(baseUrl), `${apiKey}\n`, { mode: 0o600 });
  } catch (_) { /* 写不进就只在本次会话使用 */ }
}

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

/** 帮助类输出统一以空行收尾（与参考实现 wink-cli --help 的字节输出一致）。 */
function printHelp(text) {
  out(text);
  out("");
}

function progress(line = "") {
  process.stderr.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 登录

/**
 * 取 api_key：显式 --api-key > WINK_CLI_API_KEY > 本地登录缓存 > 走一次 SSO 授权。
 * 授权成功后的 key 按服务地址分别缓存，避免跨环境复用登录凭据。
 */
async function ensureApiKey(client, flags, hooks = {}) {
  const explicit = optionValue(flags, "api-key");
  if (explicit) return explicit;
  if (!optionFlag(flags, "relogin")) {
    if (process.env.WINK_CLI_API_KEY) return process.env.WINK_CLI_API_KEY;
    const cached = (hooks.readCredential || readCredential)(client.baseUrl);
    if (cached) return cached;
  }
  const link = client.authUrl();
  progress("未检测到可用的 api_key，开始 SSO 授权登录…");
  progress(`授权链接: ${link.auth_url}`);
  (hooks.openBrowser || openBrowser)(link.auth_url);
  progress(`等待浏览器完成授权（最长 ${LOGIN_TIMEOUT_SECONDS} 秒）…`);
  const now = hooks.now || Date.now;
  const deadline = now() + LOGIN_TIMEOUT_SECONDS * 1000;
  let lastStatus = "", displayedStatus = "";
  while (now() < deadline) {
    try {
      const r = await client.exchange(link.once_code);
      const key = r && r.code === 0 && r.data && r.data.api_key;
      if (typeof key === "string" && key) {
        (hooks.writeCredential || writeCredential)(key, client.baseUrl);
        progress("授权成功，登录凭据已保存");
        return key;
      }
      lastStatus = responseOk(r) ? "授权接口未返回有效的 api_key" : serverError(r);
    } catch (error) {
      lastStatus = error.message || "授权接口请求失败";
    }
    if (lastStatus !== displayedStatus) {
      progress(`授权状态: ${lastStatus}（继续等待浏览器授权回调）`);
      displayedStatus = lastStatus;
    }
    await (hooks.sleep || sleep)(POLL_INTERVAL_SECONDS * 1000);
  }
  throw new WinkError(`SSO 授权超时，接口: ${client.baseUrl}/init/exchange${lastStatus ? `；最后响应: ${lastStatus}` : ""}。请重新运行命令，并在新打开的授权页完成授权`);
}

// ---------------------------------------------------------------- 云处理

/** 图片及 MP4/MOV 优先读取容器元信息，读取失败后使用可选的 ffprobe。 */
function probeMedia(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw new WinkError("输入文件为空或不是普通文件");
  const contentType = contentTypeOfFile(file);
  if (contentType === "2" && [".mp4", ".mov", ".m4v", ".3gp"].includes(path.extname(file).toLowerCase())) {
    const video = readMp4Metadata(file, stat.size);
    if (video) return { ...video, size: stat.size };
  }
  if (contentType === "1") {
    // 限制读取量，避免大图占满内存；尺寸头超出范围时交给可选的 ffprobe。
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    const fd = fs.openSync(file, "r");
    let bytesRead;
    try { bytesRead = fs.readSync(fd, header, 0, header.length, 0); }
    finally { fs.closeSync(fd); }
    try {
      const { width, height } = imageSize(header.subarray(0, bytesRead));
      if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
        return { width, height, size: stat.size };
      }
    } catch (_) { /* 无法识别或头信息不足时，继续走已有探测/直接投递流程。 */ }
  }
  let metadata;
  try {
    metadata = JSON.parse(execFileSync(process.env.WINK_FFPROBE_PATH || "ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration",
      "-of", "json", file,
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    if (error.code === "ENOENT") return { size: stat.size };
    throw new WinkError("无法读取媒体信息：文件损坏、格式不受支持或探测超时");
  }
  const stream = (metadata.streams || []).find((item) => item.codec_type === "video" && item.width > 0 && item.height > 0);
  if (!stream) throw new WinkError("输入文件没有可处理的图像或视频画面");
  const duration = Number(metadata.format?.duration ?? stream.duration);
  if (contentType === "2" && (!Number.isFinite(duration) || duration <= 0)) {
    throw new WinkError("无法读取视频时长，未投递该文件");
  }
  return { width: stream.width, height: stream.height, size: stat.size,
    ...(contentType === "2" ? { duration } : {}) };
}

function serverError(payload) {
  const data = dataObject(payload);
  const message = payload?.message || payload?.msg || data.error_msg || taskState(data).reason || "服务端未返回错误说明";
  return `${message}${payload?.code != null ? `（code=${payload.code}）` : ""}`;
}

async function runCloudTool(command, flags, services = {}, environment = resolveEnvironment(flags)) {
  const tool = COMMANDS[command];
  const inputRaw = optionValue(flags, "input");
  let prepared;
  try {
    if (flags.level === true) throw new WinkError("--level 需要档位编号");
    prepared = prepareTool(command, flags);
    if (prepared.reference) (services.probeMedia || probeMedia)(prepared.reference);
  } catch (error) { progress(`错误: ${error.message}`); return 1; }
  const listStyles = prepared.beauty?.listStyles === true;
  if (!inputRaw && !listStyles) {
    progress("错误: --input 为必填项（多个路径以英文“,”号隔开，支持文件夹）");
    progress("");
    progress(toolHelp(command));
    progress("");
    return 1;
  }
  const levelRaw = optionValue(flags, "level");
  const level = levelRaw === undefined ? tool.defaultLevel : Number(levelRaw);
  if (!levelInfo(level, command)) {
    progress(`错误: 不支持的档位 --level ${levelRaw}（可用: ${levelRangeText(command)}）`);
    return 1;
  }
  const { env, baseUrl, isTest } = environment;
  const interval = Number(optionValue(flags, "interval") || POLL_INTERVAL_SECONDS);
  const timeout = Number(optionValue(flags, "timeout") || POLL_TIMEOUT_SECONDS);
  if (![interval, timeout].every((value) => Number.isFinite(value) && value > 0)) {
    progress("错误: --interval 和 --timeout 必须为大于 0 的数字");
    return 1;
  }
  const asJson = optionFlag(flags, "json");

  let files = [];
  if (!listStyles) {
    const roots = splitInputs(inputRaw);
    if (roots.some((root) => !path.isAbsolute(root))) {
      progress("错误: --input 必须使用当前系统的绝对路径");
      return 1;
    }
    const collected = collectInputs(roots);
    files = collected.files;
    for (const item of collected.missing) progress(`警告: 路径不存在，已跳过: ${item}`);
    for (const item of collected.skipped) progress(`警告: 不支持的媒体类型，已跳过: ${item}`);
    if (!files.length) {
      progress("错误: 没有找到可处理的输入媒体文件");
      return 1;
    }
  }

  const client = (services.createClient || ((options) => new WinkClient(options)))({ baseUrl, log: (line) => progress(`        ${line}`) });
  let apiKey;
  try {
    apiKey = await ensureApiKey(client, flags, services.auth);
  } catch (error) {
    progress(`错误: ${error.message}`);
    return 1;
  }
  const authed = client.withApiKey(apiKey);

  let beautyStyle;
  let beautyStyles;
  if (command === "ai_beauty") {
    try {
      const styles = await fetchBeautyStyles(authed, { isTest: isTest ? 1 : 0 });
      if (listStyles) {
        out(asJson ? JSON.stringify({ ok: true, command, env, styles }, null, 2) : formatBeautyStyles(styles));
        return 0;
      }
      beautyStyles = styles;
      beautyStyle = selectBeautyStyle(styles, prepared.beauty.styleId);
    } catch (error) {
      progress(`错误: 获取或选择 AI 美容风格失败，未投递任务：${error.message}`);
      return 1;
    }
  }

  // 登录后先获取能力配置；配置不可用时禁止跳过校验直接投递。
  let configPayload = null;
  try {
    configPayload = await authed.aiTypeConfig();
    if (!responseOk(configPayload)) throw new WinkError(serverError(configPayload));
    if (!Array.isArray(configPayload.data) || !configPayload.data.length) throw new WinkError("云处理配置列表为空");
  } catch (error) {
    progress(`错误: 获取云处理配置失败，未投递任务：${error.message}`);
    progress("如果服务端提示登录失效，请添加 --relogin 重新授权。");
    return 1;
  }

  progress(`${tool.name} · 档位 ${level} ${levelInfo(level, command).name} · 共 ${files.length} 个输入`);
  progress("");

  const results = [];
  let succeeded = 0;
  let failed = 0;
  let referenceUpload;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const contentType = contentTypeOfFile(file);
    let info;
    let media;
    let beautySubmission;
    let selectedBeautyStyle = beautyStyle;
    try {
      info = taskTypeFor(level, contentType, command);
      if (prepared.taskType) info.taskType = prepared.taskType;
      if (prepared.beauty) {
        if (prepared.beauty.gender) {
          selectedBeautyStyle = selectBeautyStyle(beautyStyles, undefined, { gender: prepared.beauty.gender, contentType });
        }
        beautySubmission = buildBeautySubmission(prepared.beauty, selectedBeautyStyle, contentType);
      }
      media = (services.probeMedia || probeMedia)(file);
    } catch (error) {
      failed += 1;
      progress(`${file} 跳过：${error.message}`);
      results.push({ file, ok: false, reason: error.message });
      continue;
    }

    let selectedConfig;
    if (configPayload) {
      // 当前协议未提供已确认的会员状态，保持未知；不要把它硬编码为非会员。
      // 账号专属时长由投递接口校验，本地仍检查素材限制和所有账号的共同上限。
      const check = checkAiTypeSupport(configPayload, { type: info.taskType, contentType, durationSeconds: media.duration,
        configMatch: tool.configMatch,
        configValue: command === "cartoon" && contentType === "1" ? undefined : prepared.configValue, strictType: true,
        ...media, extension: path.extname(file).slice(1).toLowerCase() });
      selectedConfig = check.config;
      if (!check.ok) {
        failed += 1;
        progress(`${file} 不支持：${check.reason}`);
        results.push({ file, ok: false, reason: check.reason });
        continue;
      }
      if (tool.configMatch) info.taskType = String(selectedConfig.type);
    }

    const fileProgress = createFileProgress(file);
    let taskId;
    try {
      const started = Date.now();
      fileProgress.upload(0);
      if (prepared.reference && !referenceUpload) {
        referenceUpload = await authed.uploadFile(prepared.reference, { test: isTest, onProgress: () => {} });
      }
      const uploaded = await authed.uploadFile(file, { test: isTest, onProgress: (value) => fileProgress.upload(value) });
      fileProgress.upload(1, true);
      fileProgress.processing();
      const waitForRecharge = createRechargeHandler({
        client: authed,
        env,
        openBrowser: services.recharge?.openBrowser || openBrowser,
        report: detail => fileProgress.recharge(detail),
        now: services.recharge?.now,
        sleep: services.recharge?.sleep,
      });
      const finalPayload = await authed.run(uploaded.resource_url, {
        ...media,
        // ffprobe 和本地时长校验用秒；/task/submit 的 duration 用整数毫秒。
        ...(contentType === "2" && media.duration != null ? { duration: Math.round(media.duration * 1000) } : {}),
        contentType,
        taskType: info.taskType,
        ...prepared.submit,
        typeParams: JSON.stringify({ ...prepared.params, ...beautySubmission?.params,
          ...(command === "cartoon" && contentType === "1" ? { preview: 1 } : {}),
          ...(referenceUpload ? { cover_pic: referenceUpload.resource_url } : {}) }),
        ...(referenceUpload ? { coverPic: referenceUpload.resource_url } : {}),
        // 全能修复的票据功能/物料 ID 与配置 func_id 不同，沿用官网明确的权益标识。
        rightDetail: JSON.stringify(beautySubmission?.rightDetail || tool.rightDetail || { source: "1", touch_type: "4", function_id: String(selectedConfig?.func_id ?? info.functionId ?? "0") }),
        interval,
        timeout,
        onInsufficientBeans: async rejection => {
          await waitForRecharge(rejection);
          fileProgress.processing();
          return true;
        },
        onProgress: ({ phase, remainingMs, taskId: currentTaskId }) => {
          taskId = currentTaskId || taskId;
          if (phase === "running") fileProgress.processing(remainingMs);
        },
      });
      const state = taskState(dataObject(finalPayload), { taskType: info.taskType });
      if (!responseOk(finalPayload) || state.phase !== "finish") {
        const reason = !responseOk(finalPayload) ? serverError(finalPayload) : state.reason || "任务未完成";
        const data = dataObject(finalPayload);
        const code = data.error_code || data.result?.error_code;
        const failure = new WinkError(`处理失败: ${reason}${code ? `（code=${code}）` : ""}`);
        failure.extCode = code;
        throw failure;
      }
      const remote = resultUrl(finalPayload);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      fileProgress.finish(`${seconds}秒 → ${remote}`);
      succeeded += 1;
      results.push({
        file,
        ok: true,
        level,
        level_name: info.name,
        type: info.taskType,
        content_type: contentType,
        ...(prepared.beauty?.gender ? { beauty_style: {
          material_id: selectedBeautyStyle.material_id,
          name: selectedBeautyStyle.name,
          gender: prepared.beauty.gender,
        } } : {}),
        result_url: remote,
      });
    } catch (error) {
      failed += 1;
      const reason = `${error.message}${taskId ? ` · task_id=${taskId}` : ""}`;
      fileProgress.fail(reason);
      results.push({ file, ok: false, reason, ...(taskId ? { task_id: taskId } : {}),
        ...(error.extCode ? { error_code: error.extCode } : {}) });
    }
  }

  if (asJson) {
    out(JSON.stringify({
      ok: failed === 0,
      command,
      env,
      level,
      level_name: levelInfo(level, command).name,
      total: files.length,
      succeeded,
      failed,
      results,
    }, null, 2));
  } else {
    out("");
    out(`完成: 成功 ${succeeded} / 失败 ${failed} / 共 ${files.length}`);
  }
  if (failed === 0) return 0;
  return succeeded === 0 ? 3 : 2;
}

// ---------------------------------------------------------------- 主流程

async function main(argv, services = {}) {
  const { _, flags } = parseArgv(argv);
  let environment;
  try {
    environment = resolveEnvironment(flags);
  } catch (error) {
    progress(`错误: ${error.message}`);
    return 1;
  }
  const wantsHelp = optionFlag(flags, "help", "h");
  if (optionFlag(flags, "version", "v")) {
    out(VERSION);
    return 0;
  }
  const command = _[0];
  if (["login", "auth", "status", "logout", "unauth", "unAuth", "doctor", "skill", "version"].includes(command)) {
    // Preserve argument order and duplicates for the strict Skill parser. Route
    // auth/doctor through the same environment as cloud commands.
    const rest = argv.filter((arg, index) => index !== argv.indexOf(command));
    const args = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--env" || rest[i] === "--base-url") { i += 1; continue; }
      if (rest[i].startsWith("--env=") || rest[i].startsWith("--base-url=")) continue;
      args.push(rest[i]);
    }
    if (command !== "skill" && command !== "version") args.push(`--base-url=${environment.baseUrl}`);
    return require("./management_commands").main([command, ...args]);
  }
  if (command === "install") {
    const { INSTALL_HELP, installCli } = require("./install");
    if (wantsHelp) {
      printHelp(INSTALL_HELP);
      return 0;
    }
    if (_.length > 1) throw new Error("install 不接受额外位置参数；可使用 --prefix <目录>");
    return installCli(flags);
  }
  if (Object.hasOwn(COMMANDS, command)) {
    if (wantsHelp) {
      printHelp(toolHelp(command));
      return 0;
    }
    return runCloudTool(command, flags, services, environment);
  }
  if (!command || command === "help") {
    printHelp(MAIN_HELP);
    return 0;
  }
  progress(`未知命令: ${command}`);
  progress("");
  printHelp(MAIN_HELP);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      progress(`错误: ${(error && error.message) || error}`);
      process.exitCode = 1;
    });
}

module.exports = {
  MAIN_HELP,
  PICTURE_QUALITY_LEVELS,
  REMOVE_WATERMARK_LEVELS,
  COMMANDS,
  toolHelp,
  DEFAULT_LEVEL,
  DEFAULT_ENV,
  ENVIRONMENTS,
  resolveEnvironment,
  credentialFile,
  parseArgv,
  optionValue,
  optionFlag,
  levelInfo,
  levelRangeText,
  taskTypeFor,
  splitInputs,
  contentTypeOfFile,
  collectInputs,
  defaultOutputDir,
  uniqueOutputPath,
  probeMedia,
  ensureApiKey,
  pictureQualityHelp,
  main,
};
