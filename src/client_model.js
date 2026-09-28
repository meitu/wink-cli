"use strict";

const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const MAX_MODEL_LENGTH = 128;
let cachedModel;

/** Collapse whitespace and bound length for submit/query client_model. */
function normalizeModel(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_MODEL_LENGTH);
}

function cpuModel(cpus) {
  const list = Array.isArray(cpus) ? cpus : [];
  return normalizeModel(list[0] && list[0].model);
}

function looksAndroid(env = {}) {
  return Boolean(
    env.ANDROID_ROOT || env.ANDROID_DATA || env.ANDROID_STORAGE ||
    env.PREFIX && String(env.PREFIX).includes("com.termux") ||
    env.TERMUX_VERSION,
  );
}

function looksHarmony(env = {}) {
  return Boolean(
    env.OHOS_ROOT || env.HOS_ROOT || env.HARMONY_HOME ||
    (env.LD_LIBRARY_PATH && /\/system\/lib64?\/ndk/.test(String(env.LD_LIBRARY_PATH))),
  );
}

function looksIos(env = {}, platform = "") {
  return Boolean(
    env.IPHONEOS_DEPLOYMENT_TARGET || env.IOS_MODEL || env.SIMULATOR_DEVICE_NAME ||
    env.SIMULATOR_MODEL_IDENTIFIER || platform === "ios",
  );
}

function runGetprop(name, { execFile = execFileSync, env } = {}) {
  try {
    return normalizeModel(execFile("getprop", [name], {
      encoding: "utf8",
      timeout: 1000,
      env: env || process.env,
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (_) {
    return "";
  }
}

function readBuildProp(name, { readFile = fs.readFileSync, paths = ["/system/build.prop", "/vendor/build.prop"] } = {}) {
  for (const file of paths) {
    try {
      const text = readFile(file, "utf8");
      const match = text.match(new RegExp(`^${name.replace(/\./g, "\\.")}=(.*)$`, "m"));
      const value = normalizeModel(match && match[1]);
      if (value) return value;
    } catch (_) { /* missing or unreadable */ }
  }
  return "";
}

function darwinHwModel({ execFile = execFileSync } = {}) {
  try {
    return normalizeModel(execFile("sysctl", ["-n", "hw.model"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (_) {
    return "";
  }
}

function windowsComputerModel({ execFile = execFileSync } = {}) {
  // Prefer CIM; fall back to legacy WMIC when PowerShell is unavailable.
  try {
    const text = execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance -ClassName Win32_ComputerSystem).Model",
    ], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const value = normalizeModel(text.replace(/\r/g, ""));
    if (value && !/^model$/i.test(value)) return value;
  } catch (_) { /* try WMIC */ }
  try {
    const text = execFile("wmic", ["computersystem", "get", "model"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const value = normalizeModel(lines.find((line) => !/^model$/i.test(line)));
    if (value) return value;
  } catch (_) { /* ignore */ }
  return "";
}

/**
 * Infer client_model for /task/submit and /task/query.
 * Desktop prefers CPU marketing names (e.g. "Apple M4"); Android / HarmonyOS
 * prefer product model; iOS uses simulator/device hints when present.
 */
function detectClientModel({
  env = process.env,
  platform = process.platform,
  arch = os.arch(),
  cpus = os.cpus(),
  execFile = execFileSync,
  readFile = fs.readFileSync,
  useCache = true,
} = {}) {
  if (useCache && cachedModel) return cachedModel;

  const source = env && typeof env === "object" ? env : {};
  let model = "";

  if (looksIos(source, platform)) {
    model = normalizeModel(source.IOS_MODEL || source.SIMULATOR_MODEL_IDENTIFIER || source.SIMULATOR_DEVICE_NAME) || "iOS";
  } else if (looksHarmony(source) || looksAndroid(source)) {
    // Device marketing / product model (e.g. "Mate 60 Pro", "Pixel 8").
    model = runGetprop("ro.product.marketname", { execFile, env: source })
      || runGetprop("ro.product.model", { execFile, env: source })
      || readBuildProp("ro.product.marketname", { readFile })
      || readBuildProp("ro.product.model", { readFile })
      || cpuModel(cpus);
  } else if (platform === "darwin") {
    // Prefer chip name ("Apple M4") over board id ("Mac16,1").
    model = cpuModel(cpus) || darwinHwModel({ execFile });
  } else if (platform === "win32") {
    model = cpuModel(cpus) || windowsComputerModel({ execFile });
  } else {
    // Linux and other desktops: CPU model, else uname-style fallback.
    model = cpuModel(cpus);
  }

  if (!model) model = normalizeModel([platform, arch].filter(Boolean).join("-"));
  if (useCache && model) cachedModel = model;
  return model;
}

function clearClientModelCache() {
  cachedModel = undefined;
}

module.exports = {
  normalizeModel,
  detectClientModel,
  clearClientModelCache,
  looksAndroid,
  looksHarmony,
  looksIos,
};
