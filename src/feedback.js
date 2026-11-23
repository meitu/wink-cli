"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WinkClient } = require("./wink_client");
const { ENVIRONMENTS } = require("./runtime_config");
const { readCredential } = require("./management_commands");
const { redactText } = require("./tracking");
const VERSION = require("../package.json").version;

const FEEDBACK_HELP = `wink-cli feedback — 提交使用反馈（跟随原任务环境）
用法: wink-cli feedback --env <pre|beta|release> --type bug --content-file <UTF-8文件> --context-id <本次任务标识> [--suggestion-file <文件>] [--channel <已确认的渠道>] [--json | --silent]

类型: bug / suggestion / other。content 1–2000 字，suggestion 最多 2000 字。
自动反馈仅限 Skill 判断为可复现的公共问题；功能建议由用户明确要求后提交。
只使用原任务环境的现有凭据，不自动登录、不上传素材、不跨环境，不重试。
--silent 不输出反馈结果或错误，退出码始终为 0；原任务错误仍须如实交付。
同一账号、context-id 和脱敏内容仅尝试一次，包括超时或状态未知的情况。
可选: --country-code <码> --client-language <语言>；不推断未明确的 channel。`;

function field(value, name, max, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || Array.from(value.trim()).length > max) {
    throw new Error(`${name} 需要${required ? "非空" : ""}文本，最多 ${max} 字符`);
  }
  return value.trim();
}
function readText(file, name) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(`${name} 需要绝对文件路径`);
  if (fs.statSync(file).size > 65536) throw new Error(`${name} 文件超过 64 KiB`);
  return fs.readFileSync(file, "utf8");
}
function sanitize(value, name, required) {
  field(value, name, 2000, required);
  // Strip URLs/paths before credential and contact redaction; never upload raw logs.
  const clean = value.replace(/(?:https?:\/\/|file:\/\/)[^\s<>"']+/gi, "[链接]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|Volumes)\/)[^\r\n,，;；]+/g, "[本地路径]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|cookie|password|token|密码)[\"\']?\s*(?:[=:：]\s*|\s+)[^\r\n]+/gi, "[凭据已隐藏]");
  return field(redactText(clean), name, 2000, required);
}

async function runFeedback(flags, environment, services = {}) {
  const silent = flags.silent === true;
  const output = value => { if (!silent) process.stdout.write(JSON.stringify(value) + "\n"); };
  try {
    const allowed = ["env", "base-url", "type", "content-file", "suggestion-file", "context-id", "channel", "country-code", "client-language", "json", "silent"];
    const unknown = Object.keys(flags).filter(key => !allowed.includes(key));
    if (unknown.length || services.positional?.length) throw new Error("feedback 包含不支持的参数");
    if (flags.silent !== undefined && flags.silent !== true) throw new Error("--silent 不接受参数值");
    if (flags.json !== undefined && flags.json !== true) throw new Error("--json 不接受参数值");
    // Only send to the selected official environment, never forward credentials across environments.
    if (!Object.hasOwn(ENVIRONMENTS, environment.env) || environment.baseUrl !== ENVIRONMENTS[environment.env]) {
      output({ok: true, status: "skipped", reason: "official_environment_only"}); return 0;
    }
    const type = flags.type;
    if (!["bug", "suggestion", "other"].includes(type)) throw new Error("--type 仅支持 bug / suggestion / other");
    const contextId = field(flags["context-id"], "context-id", 256, true);
    const body = {client_id: "1189857724", type,
      content: sanitize(readText(flags["content-file"], "content-file"), "content", true), cli_version: VERSION};
    if (flags["suggestion-file"] !== undefined) body.suggestion = sanitize(readText(flags["suggestion-file"], "suggestion-file"), "suggestion", false);
    for (const [flag, key, max] of [["channel", "channel", 64], ["country-code", "country_code", 32], ["client-language", "client_language", 32]]) {
      if (flags[flag] !== undefined) body[key] = field(flags[flag], key, max);
    }
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, "utf8") > 65536) throw new Error("反馈请求超过 64 KiB");
    const apiKey = (services.readCredential || readCredential)(environment.baseUrl);
    if (!apiKey) { output({ok: true, status: "skipped", reason: "not_connected"}); return 0; }
    for (const key of ["content", "suggestion"]) {
      if (body[key]) body[key] = body[key].split(apiKey).join("[凭据已隐藏]");
    }
    const hash = crypto.createHash("sha256").update(JSON.stringify([
      environment.baseUrl, apiKey, contextId, type, body.content, body.suggestion, body.channel,
    ])).digest("hex");
    const dir = path.join(services.homeDir || os.homedir(), ".wink-mcp-server", "feedback-attempts");
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    try { fs.writeFileSync(path.join(dir, hash), "attempted\n", {flag: "wx", mode: 0o600}); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      output({ok: true, status: "skipped", reason: "duplicate"}); return 0;
    }
    const client = services.createClient ? services.createClient({baseUrl: environment.baseUrl, apiKey}) : new WinkClient({baseUrl: environment.baseUrl, apiKey});
    const result = await client.submitFeedback(body);
    if (result?.code !== 0 || typeof result?.data?.feedback_id !== "string" || !/^\d+$/.test(result.data.feedback_id)) {
      output({ok: false, status: "unconfirmed", code: typeof result?.code === "number" ? result.code : null}); return silent ? 0 : 1;
    }
    output({ok: true, status: "submitted", feedback_id: result.data.feedback_id});
    return 0;
  } catch (error) {
    // Never expose raw server errors, credentials or file contents through feedback failures.
    output({ok: false, status: "failed", reason: "feedback_validation_or_request_failed",
      ...(typeof error.extCode === "number" ? {code: error.extCode} : {}),
      ...(typeof error.httpStatus === "number" ? {http_status: error.httpStatus} : {})});
    return silent ? 0 : 1;
  }
}

module.exports = { FEEDBACK_HELP, runFeedback, sanitize };
