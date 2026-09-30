"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { WinkClient } = require("../src/wink_client");
const { createTracking, redactPrompt, installationId } = require("../src/tracking");
const { reportPacket } = require("../src/tracking_worker");
const { createRechargeHandler } = require("../src/beans");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-tracking-test-"));
  const oldGnum = process.env.WINK_TASK_GNUM;
  process.env.WINK_TASK_GNUM = "900000009";
  let server;
  try {
    const secret = "修复视频 联系 test@example.com 13812345678 token=topsecret https://example.com/private?q=secret /Users/example/private.mov";
    const redacted = redactPrompt(secret);
    for (const value of ["test@example", "138123", "topsecret", "example.com", "example/private"]) assert.ok(!redacted.includes(value));
    assert.ok(redacted.includes("修复视频"));
    assert.strictEqual(redactPrompt(undefined), null);
    const packets = [];
    const client = new WinkClient({ baseUrl: "https://example.invalid", apiKey: "test-key" });
    const opts = { client, source: "workbuddy", homeDir: root, env: {}, send: p => packets.push(p) };
    const tracker = createTracking(opts);
    assert.ok(tracker.enabled);
    tracker.authSuccess(client, { user_id: "user-42", api_key: "should-not-leak" });
    tracker.emit("task_submit", { task_id: "task-42", prompt: secret, file_count: 1, media_type: "video", resource_url: "should-not-leak" });
    assert.strictEqual(packets[1].events[0].user_id, "user-42");
    assert.strictEqual(packets[1].events[0].prompt, redacted);
    assert.ok(!JSON.stringify(packets.map(p => p.events)).includes("should-not-leak"));
    assert.strictEqual(packets[1].events[0].source, "workbuddy");
    tracker.emit("task_start", {});
    tracker.emit("purchase_success", {});
    assert.strictEqual(packets.length, 2, "never invent backend-only events");
    createTracking(opts).emit("credit_insufficient", {});
    assert.strictEqual(packets[2].events[0].user_id, "user-42");
    createTracking({ ...opts, client: client.withApiKey("other-key") }).emit("credit_insufficient", {});
    assert.strictEqual(packets[3].events[0].user_id, null, "no identity leaks across users");
    assert.strictEqual(packets[3].events[0].required_credit, null);
    assert.strictEqual(packets[0].events[0].installation_id, packets[3].events[0].installation_id);
    assert.strictEqual(createTracking({ ...opts, source: "cursor" }).enabled, false);
    assert.strictEqual(createTracking({ ...opts, env: { WINK_TELEMETRY: "0" } }).enabled, false);
    assert.doesNotThrow(() => createTracking({ ...opts, send() { throw Error("offline"); } }).emit("auth_success"));
    assert.strictEqual(installationId(path.join(root, "id")), installationId(path.join(root, "id")));

    let requests = [], mode = "ok";
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ headers: req.headers, url: req.url, body });
      if (mode === "hang") return;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: mode === "ok" ? 0 : 500 }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await new WinkClient({ baseUrl, apiKey: "fixture-key", accessToken: "fixture-token" }).reportEvents([{ event: "auth_success" }], { version: "1.0 测试", channelId: "workbuddy" });
    const req = requests[0], form = new URLSearchParams(req.body);
    assert.strictEqual(req.url, "/event/report");
    assert.strictEqual(req.headers["content-type"], "application/x-www-form-urlencoded");
    assert.strictEqual(req.headers["access-token"], "fixture-token");
    assert.strictEqual(form.get("version"), "1.0 测试");
    assert.strictEqual(form.get("gnum"), "900000009");
    assert.strictEqual(form.get("client_id"), "1189857724");
    assert.strictEqual(form.get("client_language"), "zh-Hans");
    assert.deepStrictEqual(JSON.parse(form.get("events")), [{ event: "auth_success" }]);
    const packet = { baseUrl, events: [{ event: "cli_first_run" }], firstRunMarker: path.join(root, "first") };
    await Promise.all([reportPacket(packet), reportPacket(packet)]);
    assert.strictEqual(requests.length, 2, "parallel first-run is deduplicated");
    await reportPacket(packet);
    assert.strictEqual(requests.length, 2);
    mode = "error";
    const retry = { ...packet, firstRunMarker: path.join(root, "retry") };
    await reportPacket(retry);
    assert.ok(!fs.existsSync(retry.firstRunMarker));
    mode = "ok";
    await reportPacket(retry);
    assert.ok(fs.existsSync(retry.firstRunMarker));

    let count = 0, payment;
    const recharge = createRechargeHandler({ env: "release", attribution: { source: "workbuddy" },
      client: { remainAmountInfo: async () => ({ code: 0, data: { total_amount: ++count } }) },
      openBrowser: url => { payment = new URL(url); }, report() {}, sleep: async () => {} });
    await recharge({ data: { task_id: "task&42" } });
    assert.strictEqual(payment.searchParams.get("source"), "workbuddy");
    assert.strictEqual(payment.searchParams.get("trigger_task_id"), "task&42");

    // A server that never responds must not keep the actual CLI parent alive.
    mode = "hang";
    const beforeDetached = requests.length;
    const started = Date.now();
    const child = spawn(process.execPath, ["-e", `const {createTracking}=require('./src/tracking'); const {WinkClient}=require('./src/wink_client'); createTracking({client:new WinkClient({baseUrl:${JSON.stringify(baseUrl)}}), source:'workbuddy',homeDir:${JSON.stringify(root)}}).emit('auth_success'); process.stdout.write('result-ready');`], { cwd: path.join(__dirname, ".."), env: { ...process.env, WINK_TELEMETRY: "1" } });
    let output = "";
    child.stdout.on("data", b => output += b);
    const code = await new Promise(resolve => child.on("exit", resolve));
    assert.strictEqual(code, 0);
    assert.strictEqual(output, "result-ready");
    assert.ok(Date.now() - started < 1500, "reporting must not delay CLI exit until network timeout");
    const deliveryDeadline = Date.now() + 2000;
    while (requests.length === beforeDetached && Date.now() < deliveryDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.strictEqual(requests.length, beforeDetached + 1, "detached worker still delivers after the parent exits");
    console.log("tracking tests passed");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (oldGnum === undefined) delete process.env.WINK_TASK_GNUM; else process.env.WINK_TASK_GNUM = oldGnum;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
