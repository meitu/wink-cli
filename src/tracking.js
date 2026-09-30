"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { detectAgentChannelId } = require("./wink_client");
const VERSION = require("../package.json").version;

// Only explicit, allow-listed business fields can leave the process.
const FIELDS = {
  cli_first_run: [], auth_success: [],
  task_submit: ["task_id", "prompt", "media_type", "file_count"],
  credit_insufficient: ["task_id", "required_credit", "balance_credit"],
};
function redactPrompt(value) {
  if (typeof value !== "string") return null;
  return value
    .replace(/(?:https?:\/\/|file:\/\/)[^\s<>"']+/gi, "[链接]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|Volumes)\/)[^\r\n,，;；]+/g, "[本地路径]")
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "[凭据]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|密码|token)\s*[=:：]\s*)[^\s,，;；]+/gi, "$1[凭据]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/\b\d{17}[\dXx]\b/g, "[证件号]")
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, "[手机号]")
    .slice(0, 2000);
}
function installationId(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "installation-id");
  try { fs.writeFileSync(file, crypto.randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const id = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid installation id");
  return id;
}
function dispatch(packet) {
  // Credentials travel through an anonymous pipe, never command arguments or disk.
  const child = spawn(process.execPath, [path.join(__dirname, "tracking_worker.js")], {
    detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.once("finish", () => child.stdin.unref());
  child.stdin.end(JSON.stringify(packet));
  child.unref();
}
const NOOP = Object.freeze({ emit() {}, firstRun() {}, bind() {}, authSuccess() {}, enabled: false });
function createTracking({ client, source, env = process.env, homeDir = os.homedir(), send = dispatch } = {}) {
  source = source || env.WINK_TASK_CHANNEL_ID || detectAgentChannelId(env, [process.execPath, process.argv[1]]);
  if (source !== "workbuddy" || env.WINK_TELEMETRY === "0" || !client) return NOOP;
  try {
    const dir = path.join(homeDir, ".wink-mcp-server", "tracking");
    const id = installationId(dir);
    const scope = crypto.createHash("sha256").update(client.baseUrl).digest("hex").slice(0, 24);
    const marker = path.join(dir, `first-run-${scope}`);
    const identityFile = path.join(dir, `user-${scope}.json`);
    let userId = null;
    function bind(next) {
      try {
        client = next;
        userId = null;
        const saved = JSON.parse(fs.readFileSync(identityFile, "utf8"));
        if (client.apiKey && saved.key_hash === hashKey(client.apiKey)) userId = saved.user_id;
      } catch (_) { /* Unknown user stays null, never use an API key as user_id. */ }
    }
    function emit(event, fields = {}, extra = {}) {
      try {
        if (!Object.hasOwn(FIELDS, event)) return;
        const record = { event, timestamp: new Date().toISOString(), source,
          installation_id: id, user_id: userId, cli_version: VERSION, expert_id: "wink-quality-enhance" };
        for (const key of FIELDS[event]) {
          const value = fields[key];
          record[key] = key === "prompt" ? redactPrompt(value) :
            (["string", "number"].includes(typeof value) ? value : null);
        }
        send({ baseUrl: client.baseUrl, apiKey: client.apiKey, accessToken: client.accessToken,
          events: [record], options: { channelId: source, ...(env.WINK_TASK_IS_TEST != null
            ? { isTest: env.WINK_TASK_IS_TEST } : { isTest: /\/\/precliapi-/.test(client.baseUrl) ? 1 : 0 }) }, ...extra });
      } catch (_) { /* Analytics must never interrupt processing. */ }
    }
    bind(client);
    return {
      enabled: true, emit, bind,
      authSuccess(next, data = {}) {
        try {
          bind(next);
          userId = ["string", "number"].includes(typeof data.user_id) ? String(data.user_id) : null;
          fs.writeFileSync(identityFile, JSON.stringify({ key_hash: hashKey(next.apiKey || ""), user_id: userId }), { mode: 0o600 });
        } catch (_) { /* Reporting still works without identity persistence. */ }
        emit("auth_success");
      },
      firstRun() {
        try { if (!fs.existsSync(marker)) emit("cli_first_run", {}, { firstRunMarker: marker }); } catch (_) {}
      },
    };
  } catch (_) { return NOOP; }
}
function hashKey(key) { return crypto.createHash("sha256").update(key).digest("hex"); }
module.exports = { createTracking, redactPrompt, installationId };
