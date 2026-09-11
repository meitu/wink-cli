"use strict";
const assert = require("assert");
const http = require("http");
const { WinkClient } = require("../src/wink_client");
const { isInsufficientBeans, createRechargeHandler, PAYMENT_URLS } = require("../src/beans");

(async () => {
  assert.ok(isInsufficientBeans({ code: 1999, message: "当前美豆不足，请充值" }));
  for (const value of [{ code: 1999, message: "其他错误" }, { code: 7777, message: "美豆不足" }, {}, new Error("美豆不足")]) {
    assert.ok(!isInsufficientBeans(value));
  }
  function fixture(amounts, overrides = {}) {
    let time = 0, count = 0;
    const opened = [], reports = [], waits = [];
    const client = { remainAmountInfo: async options => {
      assert.ok(options.requestTimeout > 0 && options.requestTimeout <= 30);
      const amount = amounts[Math.min(count++, amounts.length - 1)];
      if (amount instanceof Error) throw amount;
      return typeof amount === "object" ? amount : { code: 0, data: { total_amount: amount } };
    } };
    return { opened, reports, waits, count: () => count, time: () => time,
      handler: createRechargeHandler({ client, env: "beta",
        openBrowser: url => { assert.ok(count > 0, "read baseline before opening browser"); opened.push(url); }, report: text => reports.push(text),
        now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, ...overrides }) };
  }
  for (const env of Object.keys(PAYMENT_URLS)) {
    const test = fixture([10, 9, 10, 11], { env });
    assert.strictEqual(await test.handler(), true);
    assert.deepStrictEqual(test.opened, [PAYMENT_URLS[env]]);
    assert.strictEqual(test.count(), 4, "equality must not resume submit");
    assert.deepStrictEqual(test.waits, [5000, 5000, 5000]);
  }
  const invalid = fixture([10, new Error("temporary"), { code: 1999, message: "余额错误" }, { code: 0, data: {} }, "99", null, 11]);
  assert.strictEqual(await invalid.handler(), true);
  assert.strictEqual(invalid.count(), 7, "missing/string balances must not trigger submission");
  const timeout = fixture([10]);
  await assert.rejects(timeout.handler(), /300 秒/);
  assert.strictEqual(timeout.time(), 300000);
  const queries = timeout.count();
  await assert.rejects(timeout.handler(), /300 秒/);
  assert.strictEqual(timeout.count(), queries, "repeated rejection must not restart the deadline");
  assert.strictEqual(timeout.opened.length, 1);
  for (const bad of [new Error("no auth"), { code: 20001, message: "invalid key" }, { code: 0, data: {} }, null, "10"]) {
    const initialFailure = fixture([bad]);
    await assert.rejects(initialFailure.handler(), /无法获取充值前余额/);
    assert.strictEqual(initialFailure.count(), 1);
    assert.strictEqual(initialFailure.opened.length, 0);
  }
  const repeated = fixture([10, 11, 11, 11, 12]);
  await repeated.handler();
  await repeated.handler();
  assert.strictEqual(repeated.count(), 5, "retry rejection must wait for a further increase");
  assert.strictEqual(repeated.opened.length, 1);
  assert.deepStrictEqual(repeated.waits, [5000, 5000, 5000]);
  const zero = fixture([0, 1]);
  assert.strictEqual(await zero.handler(), true);

  // Exercise real HTTP errors and headers, not only mocked client methods.
  let mode = "http", submits = 0, queriesCount = 0, callbacks = 0, balances = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/subscribe/remain_amount_info") {
      balances++;
      assert.strictEqual(req.headers.api_key, "fixture-key");
      assert.strictEqual(req.headers["access-token"], "fixture-account-token");
      assert.strictEqual(url.searchParams.get("client_id"), "1189857724");
      assert.strictEqual(url.searchParams.get("gnum"), "fixture-device");
      assert.strictEqual(url.searchParams.get("version"), "1.0 测试");
      res.end(JSON.stringify({ code: 0, data: { total_amount: 20 } }));
    } else if (url.pathname === "/task/submit") {
      submits++;
      if (submits === 1) {
        if (mode === "http") res.statusCode = 400;
        res.end(JSON.stringify({ code: mode === "other" ? 7777 : 1999, message: "美豆不足，请充值" }));
      } else res.end(JSON.stringify({ code: 0, data: { msg_id: "fixture-task" } }));
    } else {
      queriesCount++;
      res.end(JSON.stringify(mode === "query-error" ? { code: 1999, message: "美豆不足" } : { code: 0, data: { status: "finish", result_url: "https://example.invalid/result.jpg" } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new WinkClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture-key", accessToken: "fixture-account-token", log: () => {} });
  const options = { gnum: "fixture-device", version: "1.0 测试", onInsufficientBeans: async () => { callbacks++; return true; } };
  try {
    assert.strictEqual((await client.remainAmountInfo(options)).data.total_amount, 20);
    assert.strictEqual(balances, 1);
    for (mode of ["http", "json"]) {
      submits = callbacks = queriesCount = 0;
      assert.strictEqual((await client.run("https://example.invalid/upload.jpg", options)).code, 0);
      assert.strictEqual(submits, 2); assert.strictEqual(callbacks, 1); assert.strictEqual(queriesCount, 1);
    }
    mode = "other"; submits = callbacks = queriesCount = 0;
    assert.strictEqual((await client.run("https://example.invalid/upload.jpg", options)).code, 7777);
    assert.strictEqual(submits, 1); assert.strictEqual(callbacks, 0); assert.strictEqual(queriesCount, 0);
    mode = "query-error"; submits = 1; callbacks = 0;
    assert.strictEqual((await client.run("https://example.invalid/upload.jpg", options)).code, 1999);
    assert.strictEqual(callbacks, 0, "never retry submit in response to query failures");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("beans: environment URLs, baseline before browser and balance increases, 5s polling, 300s deadline, HTTP/JSON rejections, headers and submit-only retries passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
