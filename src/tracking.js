"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { detectAgentChannelId, resolveGnumSync } = require("./wink_client");
const { looksAndroid, looksHarmony, normalizeModel } = require("./client_model");
const { readUid, writeUid } = require("./user_identity");
const VERSION = require("../package.json").version;

// Shared by the ten cloud lifecycle events, including batch start/finish.
const CLOUD_FIELDS = ["cloud_type", "level", "level_name"];

// Only explicit, allow-listed business fields can leave the process.
const FIELDS = {
  cli_first_run: [], auth_start: [], auth_success: [],
  auth_failed: ["error_code", "error_message"],
  cloud_group_process_start: [...CLOUD_FIELDS, "group_id", "prompt", "file_count"],
  cloud_upload_start: [...CLOUD_FIELDS, "task_id", "group_id", "media_type", "duration", "file_size", "file_path"],
  cloud_upload_fail: [...CLOUD_FIELDS, "task_id", "group_id", "error_code", "error_message"],
  cloud_upload_success: [...CLOUD_FIELDS, "task_id", "group_id"],
  cloud_submit_start: [...CLOUD_FIELDS, "task_id", "group_id"],
  cloud_submit_fail: [...CLOUD_FIELDS, "task_id", "group_id", "error_code", "error_message"],
  cloud_submit_success: [...CLOUD_FIELDS, "task_id", "group_id"],
  cloud_process_fail: [...CLOUD_FIELDS, "task_id", "msg_id", "group_id"],
  cloud_process_success: [...CLOUD_FIELDS, "task_id", "msg_id", "group_id"],
  cloud_group_process_finish: [...CLOUD_FIELDS, "group_id"],
  credit_insufficient: ["task_id", "group_id", "required_credit", "balance_credit"],
};
function detectCpuModel({ cpus = os.cpus } = {}) {
  try {
    const first = cpus()?.[0];
    const model = typeof first?.model === "string" ? normalizeModel(first.model) : "";
    return model && !/^(unknown|unknown cpu|n\/a)$/i.test(model) ? model : null;
  } catch (_) { return null; }
}
function detectOperatingSystem({ platform = process.platform, env = process.env,
  release = os.release, execFile = execFileSync } = {}) {
  const names = { darwin: "macOS", macos: "macOS", win32: "Windows", windows: "Windows",
    linux: "Linux", android: "Android", ios: "iOS", ohos: "HarmonyOS", harmonyos: "HarmonyOS" };
  const explicit = names[String(env.WINK_TELEMETRY_OS_TYPE || "").trim().toLowerCase()];
  let os_type = explicit || names[platform] || platform;
  if (!explicit) {
    // Mobile runtimes can expose the underlying Linux/Darwin platform.
    if (platform === "linux" || platform === "android") {
      if (looksHarmony(env)) os_type = "HarmonyOS";
      else if (looksAndroid(env)) os_type = "Android";
    } else if (platform === "darwin" && (env.IOS_MODEL ||
        /^(iPhone|iPad|iPod)/i.test(env.SIMULATOR_MODEL_IDENTIFIER || ""))) {
      os_type = "iOS";
    }
  }
  // Native hosts can provide their actual product version, especially on iOS
  // and HarmonyOS where Node's kernel release is not the OS product version.
  let os_version = optionalText(env.WINK_TELEMETRY_OS_VERSION);
  if (os_version) return { os_type, os_version };
  function command(file, args, extraEnv = {}) {
    return execFile(file, args, {
      encoding: "utf8", timeout: 1000, maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"], env: { ...env, ...extraEnv },
    }).trim();
  }
  try {
    if (os_type === "Android") {
      os_version = optionalText(command("/system/bin/getprop", ["ro.build.version.release"]));
    } else if (os_type === "iOS") {
      // A simulator runtime version is not a deployment target or host macOS version.
      os_version = /^(iPhone|iPad|iPod)/i.test(env.SIMULATOR_MODEL_IDENTIFIER || "")
        ? optionalText(env.SIMULATOR_RUNTIME_VERSION) : null;
    } else if (os_type === "HarmonyOS") {
      // Require the native host's product version; never substitute Android/Linux.
      os_version = null;
    } else if (os_type === "macOS") {
      const value = command("/usr/bin/sw_vers", ["-productVersion"], { SYSTEM_VERSION_COMPAT: "0" });
      if (/^\d+(?:\.\d+){1,3}$/.test(value)) os_version = value;
    } else {
      // Windows: NT version/build; Linux: kernel release, not distro version.
      os_version = optionalText(release());
    }
  } catch (_) { /* Missing OS metadata must not disable analytics or processing. */ }
  return { os_type, os_version };
}
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
function createTracking({ client, source, expertId, env = process.env, homeDir = os.homedir(), send = dispatch } = {}) {
  source = source || env.WINK_TASK_CHANNEL_ID || detectAgentChannelId(env, [process.execPath, process.argv[1]]);
  if (source !== "workbuddy" || env.WINK_TELEMETRY === "0" || !client) return NOOP;
  try {
    const dir = path.join(homeDir, ".wink-mcp-server", "tracking");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const gid = resolveGnumSync({ env, homeDir });
    const model = detectCpuModel();
    const resolvedExpertId = optionalText(expertId) || optionalText(env.WINK_EXPERT_ID);
    const carrier = optionalText(env.WINK_TELEMETRY_CARRIER);
    const network = optionalText(env.WINK_TELEMETRY_NETWORK);
    const operatingSystem = detectOperatingSystem({ env });
    const scope = crypto.createHash("sha256").update(client.baseUrl).digest("hex").slice(0, 24);
    const marker = path.join(dir, `first-run-${scope}`);
    let userId = null;
    function bind(next) {
      try {
        client = next;
        userId = null;
        userId = readUid(client.baseUrl, client.apiKey, homeDir);
      } catch (_) { /* Unknown user stays null, never use an API key as user_id. */ }
    }
    function emit(event, fields = {}, extra = {}) {
      try {
        if (!Object.hasOwn(FIELDS, event)) return;
        const time = Date.now();
        const record = { event_id: event,
          gid, uid: userId, channel: source, time, carrier, network, model, ...operatingSystem,
          app_version: VERSION, cli_version: VERSION, expert_id: resolvedExpertId, params: {} };
        for (const key of FIELDS[event]) {
          const value = fields[key];
          record.params[key] = ["prompt", "error_message"].includes(key) ? redactPrompt(value) :
            (["string", "number"].includes(typeof value) ? value : null);
        }
        send({ baseUrl: client.baseUrl, apiKey: client.apiKey, accessToken: client.accessToken,
          events: [record], options: { gnum: gid, channelId: source, ...(env.WINK_TASK_IS_TEST != null
            ? { isTest: env.WINK_TASK_IS_TEST } : { isTest: /\/\/precliapi-/.test(client.baseUrl) ? 1 : 0 }) }, ...extra });
      } catch (_) { /* Analytics must never interrupt processing. */ }
    }
    bind(client);
    return {
      enabled: true, emit, bind,
      authSuccess(next, data = {}) {
        try {
          bind(next);
          userId = writeUid(next.baseUrl, next.apiKey || "", data, homeDir);
        } catch (_) { /* Reporting still works without identity persistence. */ }
        emit("auth_success");
      },
      firstRun() {
        try { if (!fs.existsSync(marker)) emit("cli_first_run", {}, { firstRunMarker: marker }); } catch (_) {}
      },
    };
  } catch (_) { return NOOP; }
}
function optionalText(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
module.exports = { createTracking, redactPrompt, detectOperatingSystem, detectCpuModel };
