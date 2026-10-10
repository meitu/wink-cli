"use strict";
const assert = require("assert");
const { readUid, writeUid, exchangeUid } = require("../src/user_identity");
const VERSION = require("../package.json").version;
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { WinkClient } = require("../src/wink_client");
const { createTracking, redactPrompt, detectOperatingSystem, detectCpuModel } = require("../src/tracking");
const { reportPacket } = require("../src/tracking_worker");
const { createRechargeHandler } = require("../src/beans");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-tracking-test-"));
  const oldGnum = process.env.WINK_TASK_GNUM;
  process.env.WINK_TASK_GNUM = "900000009";
  let server;
  try {
    assert.strictEqual(detectCpuModel({ cpus: () => [{ model: " Apple   M4 " }] }), "Apple M4");
    assert.strictEqual(detectCpuModel({ cpus: () => [] }), null);
    assert.strictEqual(detectCpuModel({ cpus: () => [{ model: "unknown" }] }), null);
    assert.strictEqual(detectCpuModel({ cpus: () => { throw Error("unavailable"); } }), null);
    const expectedCpuModel = detectCpuModel();
    assert.strictEqual(exchangeUid({ user_info: { uid: "1813010157" }, user_id: "legacy" }), "1813010157");
    assert.strictEqual(exchangeUid({ user_info: { uid: 1813010157 } }), "1813010157");
    assert.strictEqual(exchangeUid({ user_info: { uid: Number.MAX_SAFE_INTEGER + 1 } }), null);
    writeUid("https://identity.invalid", "key-a", { user_info: { uid: "9223372036854775807" } }, root);
    assert.strictEqual(readUid("https://identity.invalid/", "key-a", root), "9223372036854775807");
    assert.strictEqual(readUid("https://identity.invalid", "key-b", root), null);
    assert.strictEqual(readUid("https://another.invalid", "key-a", root), null);
    writeUid("https://identity.invalid", "key-b", {}, root);
    assert.strictEqual(readUid("https://identity.invalid", "key-b", root), null);
    assert.strictEqual(readUid("https://identity.invalid", "key-a", root), null);
    const noCommand = () => { throw new Error("must not run a command"); };
    assert.deepStrictEqual(detectOperatingSystem({ env: {}, platform: "win32", release: () => "10.0.26100", execFile: noCommand }),
      { os_type: "Windows", os_version: "10.0.26100" });
    assert.deepStrictEqual(detectOperatingSystem({ env: {}, platform: "linux", release: () => "6.8.0-60-generic", execFile: noCommand }),
      { os_type: "Linux", os_version: "6.8.0-60-generic" });
    assert.deepStrictEqual(detectOperatingSystem({ env: {}, platform: "darwin", release: () => "24.6.0",
      execFile: (command, args, options) => {
        assert.strictEqual(command, "/usr/bin/sw_vers");
        assert.deepStrictEqual(args, ["-productVersion"]);
        assert.strictEqual(options.timeout, 1000);
        assert.strictEqual(options.env.SYSTEM_VERSION_COMPAT, "0");
        return "15.6.1\n";
      } }), { os_type: "macOS", os_version: "15.6.1" });
    for (const execFile of [() => { throw Error("timeout"); }, () => "", () => "invalid"]) {
      assert.deepStrictEqual(detectOperatingSystem({ env: {}, platform: "darwin", release: () => "24.6.0", execFile }),
        { os_type: "macOS", os_version: null }, "never mislabel a Darwin kernel version as a macOS version");
    }
    assert.deepStrictEqual(detectOperatingSystem({ env: {}, platform: "linux", release: () => { throw Error("unavailable"); } }),
      { os_type: "Linux", os_version: null });
    for (const platform of ["android", "linux"]) {
      assert.deepStrictEqual(detectOperatingSystem({ platform, env: { ANDROID_ROOT: "/system" },
        release: () => "6.1.0", execFile: (cmd, args) => {
          assert.strictEqual(cmd, "/system/bin/getprop");
          assert.deepStrictEqual(args, ["ro.build.version.release"]);
          return "15\n";
        } }), { os_type: "Android", os_version: "15" });
    }
    assert.deepStrictEqual(detectOperatingSystem({ platform: "android", env: {}, release: () => "6.1.0", execFile: noCommand }),
      { os_type: "Android", os_version: null });
    assert.deepStrictEqual(detectOperatingSystem({ platform: "linux", env: { OHOS_ROOT: "/system", ANDROID_ROOT: "/system" }, release: () => "6.1.0", execFile: noCommand }),
      { os_type: "HarmonyOS", os_version: null }, "HarmonyOS takes precedence over Android hints");
    assert.deepStrictEqual(detectOperatingSystem({ platform: "ohos", env: { WINK_TELEMETRY_OS_VERSION: "5.0.0" }, execFile: noCommand }),
      { os_type: "HarmonyOS", os_version: "5.0.0" });
    assert.deepStrictEqual(detectOperatingSystem({ platform: "darwin", env: { IOS_MODEL: "iPhone 16" }, release: () => "24.0.0", execFile: noCommand }),
      { os_type: "iOS", os_version: null });
    assert.deepStrictEqual(detectOperatingSystem({ platform: "darwin", env: { SIMULATOR_MODEL_IDENTIFIER: "iPhone17,3", SIMULATOR_RUNTIME_VERSION: "18.5" }, execFile: noCommand }),
      { os_type: "iOS", os_version: "18.5" });
    assert.deepStrictEqual(detectOperatingSystem({ platform: "linux", env: { WINK_TELEMETRY_OS_TYPE: "iOS", WINK_TELEMETRY_OS_VERSION: "18.5" }, execFile: noCommand }),
      { os_type: "iOS", os_version: "18.5" });
    assert.deepStrictEqual(detectOperatingSystem({ platform: "darwin", env: { IPHONEOS_DEPLOYMENT_TARGET: "12.0", ANDROID_ROOT: "/sdk" }, execFile: () => "15.6.1" }),
      { os_type: "macOS", os_version: "15.6.1" }, "desktop SDK settings are not mobile runtime versions");
    const expectedOS = detectOperatingSystem({ env: {} });
    const secret = "修复视频 联系 test@example.com 13812345678 token=topsecret https://example.com/private?q=secret /Users/example/private.mov";
    const redacted = redactPrompt(secret);
    for (const value of ["test@example", "138123", "topsecret", "example.com", "example/private"]) assert.ok(!redacted.includes(value));
    assert.ok(redacted.includes("修复视频"));
    assert.strictEqual(redactPrompt(undefined), null);
    const packets = [];
    const client = new WinkClient({ baseUrl: "https://example.invalid", apiKey: "test-key" });
    const opts = { client, source: "workbuddy", homeDir: root,
      env: { WINK_TASK_GNUM: "9223372036854775807", WINK_TASK_CLIENT_MODEL: "Test CPU", WINK_EXPERT_ID: "wink-quality-restoration" },
      send: p => packets.push(p) };
    const tracker = createTracking(opts);
    assert.ok(tracker.enabled);
    tracker.authSuccess(client, { user_info: { uid: "user-42" }, api_key: "should-not-leak" });
    tracker.emit("cloud_group_process_start", { group_id: "group-42", prompt: secret, file_count: 1, media_type: "video", resource_url: "should-not-leak" });
    assert.strictEqual(packets[1].events[0].uid, "user-42");
    assert.strictEqual(packets[1].events[0].params.prompt, redacted);
    assert.ok(!JSON.stringify(packets.map(p => p.events)).includes("should-not-leak"));
    assert.strictEqual(packets[1].events[0].channel, "workbuddy");
    for (const packet of packets) {
      const record = packet.events[0];
      assert.strictEqual(record.gid, "9223372036854775807", "gid preserves int64 precision");
      assert.strictEqual(packet.options.gnum, record.gid, "form gnum and event gid must match");
      assert.strictEqual(record.uid, "user-42");
      assert.ok(!Object.hasOwn(record, "user_id"));
      assert.ok(!Object.hasOwn(record, "installation_id"));
      assert.strictEqual(record.channel, "workbuddy");
      assert.ok(!Object.hasOwn(record, "source"));
      assert.ok(!Object.hasOwn(record, "timestamp"));
      assert.ok(Math.abs(Date.now() - record.time) < 5000, "time is a current Unix millisecond timestamp");
      assert.ok(Number.isSafeInteger(record.time));
      assert.strictEqual(record.model, expectedCpuModel);
      assert.strictEqual(record.expert_id, "wink-quality-restoration");
      assert.strictEqual(record.carrier, null);
      assert.strictEqual(record.network, null);
    }
    const extraPackets = [];
    createTracking({ ...opts, expertId: " wink-photo-quality-enhance ", clientModel: "Phone model must not override CPU",
      env: { ...opts.env, WINK_TELEMETRY_CARRIER: "中国移动", WINK_TELEMETRY_NETWORK: "WiFi" },
      send: p => extraPackets.push(p) }).emit("cloud_group_process_start");
    assert.strictEqual(extraPackets[0].events[0].model, expectedCpuModel);
    assert.strictEqual(extraPackets[0].events[0].expert_id, "wink-photo-quality-enhance");
    const missingExpert = [];
    createTracking({ ...opts, env: { ...opts.env, WINK_EXPERT_ID: "  " },
      send: p => missingExpert.push(p) }).emit("auth_success");
    assert.strictEqual(missingExpert[0].events[0].expert_id, null);
    assert.strictEqual(extraPackets[0].events[0].carrier, "中国移动");
    assert.strictEqual(extraPackets[0].events[0].network, "WiFi");
    const mobilePackets = [];
    createTracking({ ...opts, env: { ...opts.env, WINK_TELEMETRY_OS_TYPE: "HarmonyOS", WINK_TELEMETRY_OS_VERSION: "5.0.0" },
      send: packet => mobilePackets.push(packet) }).emit("auth_success");
    assert.strictEqual(mobilePackets[0].events[0].model, expectedCpuModel);
    assert.strictEqual(mobilePackets[0].events[0].os_type, "HarmonyOS");
    assert.strictEqual(mobilePackets[0].events[0].os_version, "5.0.0");
    tracker.emit("task_start", {});
    tracker.emit("task_submit", {});
    tracker.emit("purchase_success", {});
    tracker.emit("purchase_failed", {});
    assert.strictEqual(packets.length, 2, "never invent backend-only events");
    createTracking(opts).emit("credit_insufficient", {});
    assert.strictEqual(packets[2].events[0].uid, "user-42");
    createTracking({ ...opts, client: client.withApiKey("other-key") }).emit("credit_insufficient", {});
    assert.strictEqual(packets[3].events[0].uid, null, "uid must not reuse another account's identity");
    assert.strictEqual(packets[3].events[0].params.required_credit, null);
    assert.strictEqual(packets[0].events[0].gid, packets[3].events[0].gid);
    assert.strictEqual(createTracking({ ...opts, source: "cursor" }).enabled, false);
    assert.strictEqual(createTracking({ ...opts, env: { WINK_TELEMETRY: "0" } }).enabled, false);
    assert.doesNotThrow(() => createTracking({ ...opts, send() { throw Error("offline"); } }).emit("auth_success"));
    tracker.firstRun();
    tracker.emit("credit_insufficient", { installation_id: "must-not-leak", user_id: "must-not-leak" });
    for (const packet of packets) {
      assert.strictEqual(packet.events[0].app_version, VERSION);
      assert.strictEqual(packet.events[0].cli_version, VERSION);
      assert.ok(Object.hasOwn(packet.events[0], "gid"));
      assert.ok(Object.hasOwn(packet.events[0], "uid"));
      assert.strictEqual(packet.events[0].os_type, expectedOS.os_type);
      assert.strictEqual(packet.events[0].os_version, expectedOS.os_version);
      assert.ok(!Object.hasOwn(packet.events[0], "installation_id"));
      assert.ok(!Object.hasOwn(packet.events[0], "user_id"));
    }
    assert.ok(!fs.existsSync(path.join(root, ".wink-mcp-server", "tracking", "installation-id")));

    const lifecyclePackets = [];
    const lifecycle = createTracking({ ...opts, send: p => lifecyclePackets.push(p) });
    lifecycle.emit("cloud_upload_start", { task_id: "local-42", group_id: "group-42", media_type: 2,
      duration: 9443, file_size: 123, file_path: "/tmp/video.mp4", cloud_type: "picture_quality", level: 2, level_name: "超清", resource_url: "must-not-leak" });
    const uploaded = lifecyclePackets[0].events[0];
    assert.strictEqual(uploaded.params.task_id, "local-42");
    assert.strictEqual(uploaded.params.group_id, "group-42");
    assert.strictEqual(uploaded.params.duration, 9443);
    assert.strictEqual(uploaded.params.cloud_type, "picture_quality");
    assert.strictEqual(uploaded.params.level, 2);
    assert.strictEqual(uploaded.params.level_name, "超清");
    assert.strictEqual(uploaded.params.file_path, "/tmp/video.mp4");
    assert.ok(!Object.hasOwn(uploaded.params, "resource_url"));
    for (const event of ["cloud_upload_fail", "cloud_upload_success", "cloud_submit_start",
      "cloud_submit_fail", "cloud_submit_success", "cloud_process_fail", "cloud_process_success",
      "cloud_group_process_start", "cloud_group_process_finish"]) {
      lifecycle.emit(event, { group_id: "group-42", task_id: "local-42", msg_id: "server-42",
        cloud_type: "picture_quality", level: 2, level_name: "超清" });
      const record = lifecyclePackets.at(-1).events[0];
      assert.strictEqual(record.event, event);
      assert.strictEqual(record.params.group_id, "group-42");
      assert.strictEqual(record.params.cloud_type, "picture_quality");
      assert.strictEqual(record.params.level, 2);
      assert.strictEqual(record.params.level_name, "超清");
      if (event.startsWith("cloud_process_")) assert.strictEqual(record.params.msg_id, "server-42");
      else assert.ok(!Object.hasOwn(record.params, "msg_id"));
    }

    lifecycle.emit("auth_start");
    assert.deepStrictEqual(lifecyclePackets.at(-1).events[0].params, {});
    for (const event of ["auth_failed", "cloud_upload_fail", "cloud_submit_fail"]) {
      lifecycle.emit(event, { error_code: -1, error_message: "timeout token=secret", unexpected: "no" });
      const record = lifecyclePackets.at(-1).events[0];
      assert.strictEqual(record.params.error_code, -1);
      assert.strictEqual(record.params.error_message, "timeout token=[凭据]");
      assert.ok(!Object.hasOwn(record, "error_code"));
      assert.ok(!Object.hasOwn(record.params, "unexpected"));
    }
    assert.ok(!Object.hasOwn(uploaded, "task_id"));
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
    const reportedEvent = packets[1].events[0];
    await new WinkClient({ baseUrl, apiKey: "fixture-key", accessToken: "fixture-token" }).reportEvents([reportedEvent], { version: "1.0 测试", channelId: "workbuddy" });
    const req = requests[0], form = new URLSearchParams(req.body);
    assert.strictEqual(req.url, "/event/report");
    assert.strictEqual(req.headers["content-type"], "application/x-www-form-urlencoded");
    assert.strictEqual(req.headers["access-token"], "fixture-token");
    assert.strictEqual(form.get("version"), "1.0 测试");
    assert.strictEqual(form.get("gnum"), "900000009");
    assert.strictEqual(form.get("client_id"), "1189857724");
    assert.strictEqual(form.get("client_language"), "zh-Hans");
    assert.deepStrictEqual(JSON.parse(form.get("events")), [reportedEvent]);
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

    // Exercise CLI flag parsing through the detached HTTP report worker.
    const beforeCli = requests.length;
    const cliChild = spawn(process.execPath, ["src/cli.js", "denoise", "--help", "--expert-id", "wink-quality-restoration",
      "--channel-id", "workbuddy", "--base-url", baseUrl], {
      cwd: path.join(__dirname, ".."), stdio: "ignore",
      env: { ...process.env, HOME: path.join(root, "cli-home"), WINK_TELEMETRY: "1", WINK_EXPERT_ID: "other-expert" },
    });
    assert.strictEqual(await new Promise((resolve, reject) => {
      cliChild.on("error", reject); cliChild.on("exit", resolve);
    }), 0);
    const cliDeadline = Date.now() + 2000;
    while (requests.length === beforeCli && Date.now() < cliDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.strictEqual(requests.length, beforeCli + 1);
    const cliEvents = JSON.parse(new URLSearchParams(requests[beforeCli].body).get("events"));
    assert.strictEqual(cliEvents[0].expert_id, "wink-quality-restoration");

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
