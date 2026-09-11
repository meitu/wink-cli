#!/usr/bin/env node
"use strict";
/**
 * wink-connector —— WorkBuddy 连接器（CLI+Skill 方案）的壳脚本命令层。
 *
 * 本文件只「包装」既有能力，不改动 src/cli.js 的任何业务逻辑：
 *   init   -> npm install -g wink-cli-v2      （由 cli.json 的 init 直接执行）
 *   auth   -> wink-connector login            （打印授权链接并轮询换取 api_key）
 *   status -> wink-connector status           （只读检查，无副作用）
 *   unAuth -> wink-connector logout           （清理本地凭证）
 *
 * 关键约束（来自开放平台连接器规范）：
 *   - auth 必须在 10 秒内把完整 https:// 链接写到 stdout，前后留空白、不加引号或尖括号；
 *   - WorkBuddy 提取到链接后会立即终止 auth 子进程，因此 cli.json 必须设置
 *     authWaitForExit: true，让本进程继续轮询 /init/exchange 直到拿到 api_key；
 *   - status 只读取持久化状态、不产生副作用，登录态须跨进程重启有效；
 *   - unAuth 未登录时也必须正常返回。
 *
 * 凭证完全由 CLI 自行管理，落盘位置与 src/cli.js 的 ensureApiKey 完全一致
 * （~/.wink-mcp-server/cli-credentials/<sha256(baseUrl)[:24]>.api_key），
 * 不写入安装包、不写入 Skill、不打印明文。
 */

const fs = require("fs");
const path = require("path");
const { WinkClient, responseOk, dataObject } = require("../src/wink_client");
const { credentialFile, ENVIRONMENTS, DEFAULT_ENV } = require("../src/cli");

const VERSION = require("../package.json").version;

// 对外连接器默认使用正式环境（release），与 wink-cli 业务命令的 --env 默认值保持一致，
// 避免「登录走了 A 环境、投递走了 B 环境」的错配。
// 联调可临时用 WINK_CLI_ENV=pre|beta 或 WINK_CLI_BASE_URL 覆盖。
const RELEASE_BASE_URL = ENVIRONMENTS.release;
// SSO 轮询上限与 CLI 保持一致（300 秒），覆盖 WorkBuddy 的 5 分钟认证窗口。
const LOGIN_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_SECONDS = 3;
const MIN_NODE_MAJOR = 18;

const STATUS_TOKEN_CONNECTED = "WINK_AUTH=connected";
const STATUS_TOKEN_DISCONNECTED = "WINK_AUTH=disconnected";

function resolveBaseUrl(argv) {
  const flag = argv.find((item) => item.startsWith("--base-url="));
  if (flag) return flag.slice("--base-url=".length).replace(/\/$/, "");
  if (process.env.WINK_CLI_BASE_URL) return String(process.env.WINK_CLI_BASE_URL).replace(/\/$/, "");
  const envName = process.env.WINK_CLI_ENV || DEFAULT_ENV;
  return (ENVIRONMENTS[envName] || RELEASE_BASE_URL).replace(/\/$/, "");
}

function readCredential(baseUrl) {
  try {
    return fs.readFileSync(credentialFile(baseUrl), "utf8").trim();
  } catch (_) {
    return "";
  }
}

function writeCredential(apiKey, baseUrl) {
  const file = credentialFile(baseUrl);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${apiKey}\n`, { mode: 0o600 });
  return file;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeVersionOk() {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

// ---------------------------------------------------------------- 子命令

/** status：只读检查登录态，不使用网络、不写文件。 */
function cmdStatus(argv) {
  const baseUrl = resolveBaseUrl(argv);
  const apiKey = readCredential(baseUrl);
  if (apiKey) {
    process.stdout.write(`${STATUS_TOKEN_CONNECTED}\nWink 云端处理：已连接\n`);
  } else {
    process.stdout.write(`${STATUS_TOKEN_DISCONNECTED}\nWink 云端处理：未连接\n`);
  }
  // 无论是否已登录都以 0 退出：非零退出会被平台当作执行错误，
  // 判定登录态只看输出是否匹配 statusMatch。
  return 0;
}

/** auth：打印授权链接（10 秒内）并保持运行，轮询换取 api_key 后落盘。 */
async function cmdLogin(argv) {
  if (!nodeVersionOk()) {
    process.stderr.write(`错误：需要 Node.js ${MIN_NODE_MAJOR} 或以上，当前 ${process.version}\n`);
    return 1;
  }
  const baseUrl = resolveBaseUrl(argv);
  const client = new WinkClient({ baseUrl });
  // authUrl() 为纯本地计算，不发起网络请求，保证 10 秒内必定输出链接。
  const link = client.authUrl();
  process.stdout.write(`\n${link.auth_url}\n\n`);
  process.stderr.write("请在浏览器完成 Wink 授权，完成后无需回复，等待自动继续…\n");

  const deadline = Date.now() + LOGIN_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    try {
      const payload = await client.exchange(link.once_code);
      const data = dataObject(payload);
      const apiKey = responseOk(payload) && typeof data.api_key === "string" ? data.api_key : "";
      if (apiKey) {
        writeCredential(apiKey, baseUrl);
        process.stdout.write(`${STATUS_TOKEN_CONNECTED}\nWink 云端处理：已连接\n`);
        return 0;
      }
    } catch (_) {
      // 授权尚未完成（once_code 未生效或已过期），继续轮询。
    }
    await sleep(POLL_INTERVAL_SECONDS * 1000);
  }
  process.stderr.write("错误：授权超时，请重新连接\n");
  return 1;
}

/** unAuth：清理本地登录态；未登录时也正常返回。 */
function cmdLogout(argv) {
  const baseUrl = resolveBaseUrl(argv);
  const file = credentialFile(baseUrl);
  let removed = false;
  try {
    fs.rmSync(file, { force: true });
    removed = true;
  } catch (_) {
    removed = false;
  }
  try {
    // 目录空了就一并清掉，避免留下空目录误导排查。
    fs.rmdirSync(path.dirname(file));
  } catch (_) {
    /* 目录非空或被占用时忽略 */
  }
  process.stdout.write(`Wink 云端处理：已退出登录${removed ? "" : "（本地无凭证）"}\n`);
  // 服务端未提供会话撤销接口，此处只能清理本地凭证；如实说明，不假装已吊销远端。
  return 0;
}

/** doctor：环境自检，供 Skill 在动手前确认运行时与安装状态。 */
function cmdDoctor(argv) {
  const baseUrl = resolveBaseUrl(argv);
  const apiKey = readCredential(baseUrl);
  const report = {
    ok: nodeVersionOk(),
    node: process.version,
    node_min: MIN_NODE_MAJOR,
    cli_version: VERSION,
    base_url: baseUrl,
    logged_in: Boolean(apiKey),
    credential_file: credentialFile(baseUrl),
    result_mode: "url",
    platform: process.platform,
  };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Node.js: ${report.node}（要求 >= ${report.node_min}）${report.ok ? " 通过" : " 不通过"}`,
      `Wink CLI: ${report.cli_version}`,
      `服务地址: ${report.base_url}`,
      `登录状态: ${report.logged_in ? "已连接" : "未连接"}`,
      "处理结果: 仅返回下载链接",
    ].join("\n") + "\n");
  }
  return report.ok ? 0 : 1;
}

const HELP = [
  "wink-connector —— Wink 云端处理连接器的壳脚本命令层",
  "",
  "用法: wink-connector <命令> [--base-url=<url>] [--json]",
  "",
  "命令:",
  "  login      授权登录（输出授权链接并轮询换取 api_key）",
  "  status     检查登录状态（只读、无副作用）",
  "  logout     退出登录并清理本地凭证",
  "  doctor     环境自检（Node 版本、CLI 版本、登录状态）",
  "  version    输出版本号",
  "  help       显示本帮助",
  "",
  "业务命令请使用 wink-cli：wink-cli picture_quality --level 2 --input <绝对路径>",
].join("\n");

async function main(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "login":
    case "auth":
      return cmdLogin(rest);
    case "status":
      return cmdStatus(rest);
    case "logout":
    case "unauth":
    case "unAuth":
      return cmdLogout(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      return 0;
    default:
      process.stderr.write(`未知命令: ${command}\n${HELP}\n`);
      return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`错误: ${(error && error.message) || error}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  RELEASE_BASE_URL,
  MIN_NODE_MAJOR,
  STATUS_TOKEN_CONNECTED,
  STATUS_TOKEN_DISCONNECTED,
  resolveBaseUrl,
  readCredential,
  writeCredential,
  nodeVersionOk,
  cmdLogin,
  cmdStatus,
  cmdLogout,
  cmdDoctor,
  main,
};
