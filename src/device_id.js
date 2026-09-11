"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function normalizeGnum(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("gnum 必须使用十进制字符串，避免整数精度丢失");
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error("gnum 无效：需要十进制正整数编号（int64），不能使用 UUID 或十六进制设备标识");
  }
  return text;
}

function validGnum(value) {
  try { return normalizeGnum(value); } catch (_) { return null; }
}

/** Generate a positive signed int64 without converting through Number. */
function generateGnum() {
  let value;
  do {
    value = crypto.randomBytes(8).readBigUInt64BE() & 9223372036854775807n;
  } while (value === 0n);
  return value.toString(10);
}

/** Reuse an existing ID, or persist a locally generated ID on first use. */
function resolveGnumSync({ env = process.env, homeDir = os.homedir() } = {}) {
  if (env.WINK_TASK_GNUM) return normalizeGnum(env.WINK_TASK_GNUM);
  const dir = path.join(homeDir, ".wink-mcp-server");
  const file = path.join(dir, "task-gnum");
  try {
    const cached = validGnum(fs.readFileSync(file, "utf8"));
    if (cached) return cached;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`无法读取设备编号：${error.message}`);
  }
  // Older installations already obtained a numeric gid from the SDK. Migrate
  // only that field; do not load the SDK or restore telemetry collection.
  let legacy;
  try {
    legacy = validGnum(JSON.parse(fs.readFileSync(path.join(dir, "datareport", "dataReport.json"), "utf8")).gid);
  } catch (_) { /* No usable old SDK allocation. */ }
  const gnum = legacy || generateGnum();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${gnum}\n`, { mode: 0o600 });
  return gnum;
}

module.exports = { normalizeGnum, resolveGnumSync };
