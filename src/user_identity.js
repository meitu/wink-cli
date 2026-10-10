"use strict";

const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { credentialFile } = require("./runtime_config");

function normalizeUid(value) {
  if (typeof value === "string") return value.trim() || null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function exchangeUid(data = {}) {
  return normalizeUid(data?.user_info?.uid) || normalizeUid(data?.user_id);
}
function identityFile(baseUrl, homeDir) {
  return credentialFile(baseUrl, homeDir).replace(/(?:\.api_key)?$/, ".uid.json");
}
function keyHash(key) { return createHash("sha256").update(key).digest("hex"); }
function readUid(baseUrl, apiKey, homeDir) {
  if (!apiKey) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(identityFile(baseUrl, homeDir), "utf8"));
    return saved.key_hash === keyHash(apiKey) ? normalizeUid(saved.uid) : null;
  } catch (_) { return null; }
}
function writeUid(baseUrl, apiKey, data, homeDir) {
  const uid = exchangeUid(data);
  let temp;
  try {
    const file = identityFile(baseUrl, homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ uid, key_hash: keyHash(apiKey) }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (_) { /* Missing optional identity must not invalidate a successful login. */ }
  finally { if (temp) { try { fs.rmSync(temp, { force: true }); } catch (_) {} } }
  return uid;
}
module.exports = { exchangeUid, identityFile, readUid, writeUid };
