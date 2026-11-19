"use strict";

const { ENVIRONMENTS } = require("./runtime_config");

/** Only login queries the execution IP; no cookies, keys, or local IP values are sent. */
async function resolveAuthDomain(baseUrl, { fetchImpl = globalThis.fetch, onWarning = () => {} } = {}) {
  if (!Object.values(ENVIRONMENTS).includes(String(baseUrl).replace(/\/$/, ""))) return "wink.cn";
  for (const origin of ["https://wink.ai", "https://wink.cn"]) {
    try {
      const response = await fetchImpl(`${origin}/xapi/geo`, {
        signal: AbortSignal.timeout(2500), redirect: "error",
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const countryCode = payload?.response?.countryCode;
      if (payload?.meta?.code !== 1 || typeof countryCode !== "string" || !/^[A-Z]{2}$/.test(countryCode)) continue;
      return countryCode === "CN" ? "wink.cn" : "wink.ai";
    } catch (_) {
      // Try the other official site when its peer is unreachable or returns invalid JSON.
    }
  }
  onWarning("无法识别执行环境的公网 IP 地区，使用 wink.cn 授权入口。");
  return "wink.cn";
}

module.exports = { resolveAuthDomain };
