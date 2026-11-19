"use strict";
const assert = require("assert");
const { resolveAuthDomain } = require("../src/auth_domain");
const { ENVIRONMENTS } = require("../src/runtime_config");
const { WinkClient } = require("../src/wink_client");

(async () => {
  for (const countryCode of ["CN", "US", "ID", "HK", "TW"]) {
    let queries = 0;
    const domain = await resolveAuthDomain(ENVIRONMENTS.release, { fetchImpl: async (url, options) => {
      queries++;
      assert.equal(url, "https://wink.ai/xapi/geo");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined, "must not send credentials");
      return { ok: true, json: async () => ({ meta: {code: 1}, response: {countryCode} }) };
    } });
    assert.equal(queries, 1);
    assert.equal(domain, countryCode === "CN" ? "wink.cn" : "wink.ai");
    for (const [env, baseUrl] of Object.entries(ENVIRONMENTS)) {
      const url = new URL(new WinkClient({baseUrl}).authUrl("abcdefghijklmnopqrstuvwx01234567", "client-7", "codex", domain).auth_url);
      assert.equal(url.origin, `https://${env === "release" ? "" : env + "."}${domain}`);
      assert.equal(url.pathname, "/init/auth");
      assert.equal(url.searchParams.get("once_code"), "abcdefghijklmnopqrstuvwx01234567");
      assert.equal(url.searchParams.get("client_id"), "client-7");
      assert.equal(url.searchParams.get("channel"), "codex");
    }
  }
  for (const failure of ["network", "http", "json", "business", "missing"]) {
    const calls = [], warnings = [];
    const domain = await resolveAuthDomain(ENVIRONMENTS.beta, { onWarning: s => warnings.push(s), fetchImpl: async url => {
      calls.push(url);
      if (calls.length === 2) return {ok: true, json: async () => ({meta: {code: 1}, response: {countryCode: "CN"}})};
      if (failure === "network") throw new Error("timeout");
      return {ok: failure !== "http", json: async () => {
        if (failure === "json") throw new Error("bad JSON");
        return {meta: {code: failure === "business" ? 0 : 1}, response: {countryCode: failure === "missing" ? "" : "US"}};
      }};
    }});
    assert.equal(domain, "wink.cn");
    assert.deepEqual(calls, ["https://wink.ai/xapi/geo", "https://wink.cn/xapi/geo"]);
    assert.equal(warnings.length, 0);
  }
  const warnings = [];
  assert.equal(await resolveAuthDomain(ENVIRONMENTS.pre, {fetchImpl: async () => {throw new Error("offline");}, onWarning: s => warnings.push(s)}), "wink.cn");
  assert.equal(warnings.length, 1);
  assert.equal(await resolveAuthDomain("http://localhost:1234", {fetchImpl: async () => {throw new Error("must not query custom APIs");}}), "wink.cn");
  console.log("auth domain: execution IP, CN/overseas, environment URLs, anonymous requests, official fallback and offline warning passed");
})().catch(error => {console.error(error);process.exitCode=1;});
