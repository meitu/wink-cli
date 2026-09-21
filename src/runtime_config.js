"use strict";

const os = require("os");
const path = require("path");
const { createHash } = require("crypto");

const ENVIRONMENTS = Object.freeze({
  pre: "https://precliapi-winkcut.meitu.com",
  beta: "https://betacliapi-winkcut.meitu.com",
  release: "https://cliapi-winkcut.meitu.com",
});
const DEFAULT_ENV = "release";

// 保留历史凭据目录，避免项目精简后要求已有用户重新授权。
const CREDENTIAL_DIR = path.join(os.homedir(), ".wink-mcp-server", "cli-credentials");

function credentialFile(baseUrl) {
  const scope = createHash("sha256").update(baseUrl.replace(/\/$/, "")).digest("hex").slice(0, 24);
  return path.join(CREDENTIAL_DIR, `${scope}.api_key`);
}

module.exports = { ENVIRONMENTS, DEFAULT_ENV, CREDENTIAL_DIR, credentialFile };
