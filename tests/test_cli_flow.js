"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { main, ensureApiKey, probeMedia } = require("../src/cli");
const { WinkClient } = require("../src/wink_client");

async function capture(fn) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  let out = "", err = "";
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try {
    // Captured progress represents redirected output, even when npm publish
    // runs inside a terminal. Terminal refresh behavior has its own tests.
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
    else delete process.stderr.isTTY;
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-cli-flow-"));
  const savedKey = process.env.WINK_CLI_API_KEY;
  const savedGnum = process.env.WINK_TASK_GNUM;
  process.env.WINK_TASK_GNUM = "900000006";
  let server;
  try {
    // A relogin must ignore cached/environment keys and only exchange its own once_code.
    process.env.WINK_CLI_API_KEY = "old-test-key";
    let exchanged = 0, stored, opened;
    const auth = await capture(() => ensureApiKey({
      authUrl: () => ({ auth_url: "https://example.invalid/auth", once_code: "bound-code" }),
      exchange: async (code) => {
        assert.strictEqual(code, "bound-code");
        return ++exchanged === 1 ? { code: 20001 } : { code: 0, data: { api_key: "new-test-key" } };
      },
    }, { relogin: true }, {
      openBrowser: (url) => { opened = url; },
      readCredential: () => { throw new Error("relogin must not read cache"); },
      writeCredential: (key) => { stored = key; }, sleep: async () => {},
    }));
    assert.strictEqual(auth.code, "new-test-key");
    assert.strictEqual(stored, auth.code);
    assert.ok(opened);
    assert.ok(!auth.err.includes("new-test-key"));
    assert.match(auth.err, /授权状态:.*code=20001/);
    delete process.env.WINK_CLI_API_KEY;

    // Preserve the beta failure that used to disappear inside the polling catch.
    let loginTime = 0, loginAttempts = 0;
    const pendingMessage = "GET /init/exchange：api key不存在或once code已过期（HTTP 400，code=20001）";
    const loginTimeout = await capture(async () => {
      try {
        await ensureApiKey({
          baseUrl: "https://betacliapi-winkcut.meitu.com",
          authUrl: () => ({ auth_url: "https://example.invalid/auth", once_code: "own-code" }),
          exchange: async code => { assert.strictEqual(code, "own-code"); loginAttempts++; throw new Error(pendingMessage); },
        }, { relogin: true }, {
          openBrowser: () => {}, now: () => loginTime,
          sleep: async () => { loginTime += 150000; },
          writeCredential: () => { throw new Error("must not cache a failed login"); },
        });
        assert.fail("login must time out");
      } catch (error) { return error.message; }
    });
    assert.strictEqual(loginAttempts, 2);
    assert.strictEqual(loginTimeout.err.split("授权状态:").length - 1, 1, "unchanged authorization status must not spam output");
    assert.match(loginTimeout.code, /SSO 授权超时.*betacliapi-winkcut.*最后响应:.*HTTP 400.*code=20001/);

    let base, mode = "success", events = [], submits = [], queryCount = 0;
    let rechargeSubmits = 0, balanceCalls = 0;
    server = http.createServer(async (req, res) => {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const url = new URL(req.url, base);
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/task/ai_type_config") {
          events.push("config");
          assert.strictEqual(req.headers.api_key, "test-key");
          res.end(JSON.stringify(mode === "config-failure" ? { code: 1234, message: "配置暂不可用" } : {
            code: 0, data: [
              { type: 12, name: "超清图片", content_type: 1 },
              { type: 11, name: "超清视频", content_type: 2, min_time: 1, max_time_normal: 60, max_time: 3600 },
              { type: 8, name: "图片去水印", content_type: 1 },
              { type: 3, name: "视频去水印", content_type: 2, min_time: 1, max_time_normal: 60 },
              { type: 95, name: "图片AI去水印", content_type: 1 },
              { type: 94, name: "视频AI去水印", content_type: 2, min_time: 1, max_time_normal: 60 },
            ],
          }));
        } else if (url.pathname === "/task/submit") {
          events.push("submit");
          const form = new URLSearchParams(body);
          submits.push(Object.fromEntries(form));
          assert.ok(form.get("source_url").startsWith(base));
          assert.strictEqual(req.headers.api_key, "test-key");
          if (mode.startsWith("recharge-") && rechargeSubmits++ === 0) {
            if (mode === "recharge-http") res.statusCode = 400;
            res.end(JSON.stringify({ code: 1999, message: "美豆不足，需6美豆，当前余额0美豆" }));
            return;
          }
          if (mode === "http-parameter-failure" || (form.get("content_type") === "2" && form.has("duration") && !/^\d+$/.test(form.get("duration")))) {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: 10101, message: "参数错误" }));
            return;
          }
          if (mode === "normal-account-duration-rejection") {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: 21001, message: "当前账号不是会员，视频时长不能超过60秒" }));
            return;
          }
          res.end(JSON.stringify(mode === "beans-failure" ? { code: 7777, message: "美豆不足，请充值" } : {
            code: 0, data: { msg_id: "task-" + submits.length },
          }));
        } else if (url.pathname === "/subscribe/remain_amount_info") {
          events.push("balance");
          assert.strictEqual(req.headers.api_key, "test-key");
          assert.strictEqual(url.searchParams.get("gnum"), "900000006");
          assert.strictEqual(url.searchParams.get("is_test"), "0");
          balanceCalls++;
          if (mode === "recharge-missing-route") {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: 10007, message: "接口不存在" }));
            return;
          }
          res.end(JSON.stringify(mode === "recharge-invalid" ? { code: 0, data: {} } : {
            code: 0, data: { total_amount: balanceCalls < 3 ? 10 : 11 },
          }));
        } else if (url.pathname === "/task/query") {
          events.push("query");
          assert.ok(url.searchParams.get("msg_id").startsWith("task-"));
          assert.strictEqual(url.searchParams.get("gnum"), "900000006");
          queryCount++;
          if (mode === "algorithm-failure") {
            res.end(JSON.stringify({ code: 0, data: { result: { error_code: 29903, error_msg: "PROCESS_IMAGE_ERROR" } } }));
            return;
          }
          res.end(JSON.stringify({ code: 0, data: queryCount % 2
            ? { remaining_elapsed: 61000, result: { error_code: 29901, error_msg: "NOT_RESULT" } }
            : { result: { error_code: 0, parameter: { exist_watermark: true }, media_info_list: [{ media_data: base + "/result.jpg" }] }, url: base + "/original.jpg" } }));
        } else if (url.pathname === "/result.jpg") {
          events.push("download");
          res.setHeader("Content-Type", "image/jpeg");
          if (mode === "download-failure") { res.statusCode = 500; res.end("failed"); return; }
          if (mode === "unknown-size") { res.write("result-"); res.end("bytes"); return; }
          res.setHeader("Content-Length", Buffer.byteLength("result-bytes"));
          res.end("result-bytes");
        } else { res.statusCode = 404; res.end("{}"); }
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ code: 500, message: error.message })); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const inputDir = path.join(root, "input"), outDir = path.join(root, "output");
    fs.mkdirSync(inputDir);
    const photo = path.join(inputDir, "photo.jpg"), video = path.join(inputDir, "clip.mp4");
    fs.copyFileSync(path.join(__dirname, "fixtures", "images", "sample.jpg"), photo);
    fs.writeFileSync(video, "input-video");
    let duration = 9.443333;
    const services = {
      createClient(options) {
        const client = new WinkClient(options);
        client.withApiKey = (apiKey) => {
          const authed = new WinkClient({ ...options, apiKey });
          // The SDK's upload transport has separate end-to-end coverage.
          authed.uploadFile = async (file, options) => {
            events.push("upload");
            assert.ok(events.includes("config"));
            options.onProgress(0.0797);
            options.onProgress(0.0797);
            return { resource_url: base + "/input/" + path.basename(file) };
          };
          return authed;
        };
        return client;
      },
      probeMedia(file) { return { width: 1920, height: 1080, size: 123,
        ...(file.endsWith(".mp4") ? { duration } : {}) }; },
    };
    const args = (input) => ["picture_quality", "--level", "2", "--input", input, "--output", outDir,
      "--base-url", base, "--api-key", "test-key", "--interval", "0.001", "--json"];
    const mixed = await capture(() => main(args(inputDir + "," + photo), services));
    assert.strictEqual(mixed.code, 0, mixed.err);
    const summary = JSON.parse(mixed.out);
    assert.strictEqual(summary.total, 2, "directory and explicit file deduplicate");
    assert.strictEqual(summary.succeeded, 2);
    assert.deepStrictEqual(submits.map((x) => x.type).sort(), ["11", "12"]);
    assert.strictEqual(submits.find((x) => x.type === "11").duration, "9443", "fractional ffprobe seconds must become integer milliseconds on the wire");
    assert.strictEqual(submits[0].width, "1920");
    assert.strictEqual(queryCount, 4, "NOT_RESULT continues polling");
    for (const item of summary.results) {
      assert.strictEqual(item.result_url, base + "/result.jpg", "return algorithm output instead of the original media URL");
      assert.ok(!Object.hasOwn(item, "output") && !Object.hasOwn(item, "bytes"));
      assert.ok(mixed.err.includes(`→ ${item.result_url}`));
    }
    assert.ok(!Object.hasOwn(summary, "output_dir"));
    assert.ok(!fs.existsSync(outDir), "legacy --output must not create a directory");
    assert.ok(!events.includes("download"), "never request result media");
    for (const file of [photo, video]) {
      assert.ok(mixed.err.includes(`${file} 上传中：8%`));
      assert.ok(mixed.err.includes(`${file} 上传中：100%`));
      assert.ok(mixed.err.includes(`${file} 处理中：剩余1分1秒`));
      assert.ok(!mixed.err.includes(`${file} 下载中：`));
      assert.strictEqual(mixed.err.split(`${file} 上传中：8%`).length - 1, 1, "duplicate progress is suppressed");
    }
    assert.ok(!/upload progress=|task_id=|content_type=|\x1b/.test(mixed.err));

    for (const rechargeMode of ["recharge-json", "recharge-http", "recharge-invalid", "recharge-missing-route"]) {
      mode = rechargeMode; events = []; rechargeSubmits = balanceCalls = 0;
      let clock = 0;
      const opened = [], waits = [], beforeSubmits = submits.length;
      const charged = await capture(() => main(args(photo), { ...services, recharge: {
        now: () => clock,
        sleep: async ms => { assert.strictEqual(ms, 5000); waits.push(ms); clock += ms; },
        openBrowser: url => { assert.strictEqual(balanceCalls, 1); opened.push(url); events.push("open-payment"); },
      } }));
      if (["recharge-invalid", "recharge-missing-route"].includes(mode)) {
        assert.strictEqual(charged.code, 3, charged.err);
        assert.match(charged.err, /无法获取充值前余额/);
        assert.strictEqual(opened.length, 0);
        assert.strictEqual(rechargeSubmits, 1);
        assert.ok(!events.includes("query"));
        assert.match(charged.err, /需6美豆，当前余额0美豆/);
        assert.ok(charged.err.includes("https://wink.cn/workspace?showPayment=1"));
        assert.strictEqual(JSON.parse(charged.out).results[0].error_code, 1999);
        if (mode === "recharge-missing-route") {
          assert.match(charged.err, /remain_amount_info.*接口不存在.*code=10007/);
          assert.strictEqual(balanceCalls, 1);
          assert.strictEqual(waits.length, 0);
        }
      } else {
        assert.strictEqual(charged.code, 0, charged.err);
        assert.strictEqual(JSON.parse(charged.out).succeeded, 1);
        assert.deepStrictEqual(opened, ["https://wink.cn/workspace?showPayment=1"]);
        assert.deepStrictEqual(events.slice(0, 8), ["config", "upload", "submit", "balance", "open-payment", "balance", "balance", "submit"]);
        assert.strictEqual(balanceCalls, 3);
        assert.strictEqual(rechargeSubmits, 2);
        assert.deepStrictEqual(waits, [5000, 5000]);
        assert.deepStrictEqual(submits[beforeSubmits], submits[beforeSubmits + 1], "retry uses the same upload URL and task parameters");
        assert.match(charged.err, /美豆已从 10 增加到 11/);
      }
      assert.strictEqual(events.filter(event => event === "upload").length, 1);
    }
    mode = "success";

    // Exercise the actual probe function with an unavailable executable, for both media types.
    const savedProbePath = process.env.WINK_FFPROBE_PATH;
    try {
      process.env.WINK_FFPROBE_PATH = path.join(root, "missing-ffprobe");
      const before = submits.length;
      const withoutProbe = await capture(() => main(args(inputDir), { ...services, probeMedia }));
      assert.strictEqual(withoutProbe.code, 0, withoutProbe.err);
      assert.strictEqual(submits.length - before, 2, "missing ffprobe must not prevent image/video submission");
      for (const form of submits.slice(before)) {
        assert.ok(!Object.hasOwn(form, "duration"), "do not send NaN, zero, or invented duration");
        if (form.content_type === "1") {
          assert.strictEqual(form.width, "16", "image headers supply dimensions even without ffprobe");
          assert.strictEqual(form.height, "12");
        } else {
          assert.ok(!Object.hasOwn(form, "width"));
          assert.ok(!Object.hasOwn(form, "height"));
        }
        assert.ok(Number(form.size) > 0, "file size remains available without ffprobe");
      }
      assert.strictEqual(JSON.parse(withoutProbe.out).succeeded, 2);
      // Valid MP4/MOV metadata must reach the API in milliseconds without ffprobe.
      for (const ext of ["mp4", "mov"]) {
        const nativeVideo = path.join(root, `native.${ext}`);
        fs.copyFileSync(path.join(__dirname, "fixtures", "video", `sample.${ext}`), nativeVideo);
        const nativeResult = await capture(() => main(args(nativeVideo), { ...services, probeMedia }));
        assert.strictEqual(nativeResult.code, 0, nativeResult.err);
        const form = submits.at(-1);
        assert.strictEqual(form.content_type, "2");
        assert.strictEqual(form.type, "11");
        assert.strictEqual(form.duration, "1200");
        assert.strictEqual(form.width, "32");
        assert.strictEqual(form.height, "24");
      }
      const empty = path.join(root, "empty.jpg");
      fs.writeFileSync(empty, "");
      assert.throws(() => probeMedia(empty), /输入文件为空/);

      // An installed executable that fails must not trigger the missing-tool fallback.
      process.env.WINK_FFPROBE_PATH = process.execPath;
      const count = submits.length;
      const failedProbe = await capture(() => main(args(video), { ...services, probeMedia }));
      assert.strictEqual(failedProbe.code, 3);
      assert.match(failedProbe.err, /无法读取媒体信息/);
      assert.strictEqual(submits.length, count);
    } finally {
      if (savedProbePath === undefined) delete process.env.WINK_FFPROBE_PATH;
      else process.env.WINK_FFPROBE_PATH = savedProbePath;
    }

    for (const level of [undefined, "1", "2"]) {
      const watermarkArgs = args(inputDir);
      watermarkArgs[0] = "remove_watermark";
      if (level === undefined) watermarkArgs.splice(1, 2);
      else watermarkArgs[2] = level;
      const beforeCount = submits.length;
      const watermark = await capture(() => main(watermarkArgs, services));
      assert.strictEqual(watermark.code, 0, watermark.err);
      const result = JSON.parse(watermark.out);
      assert.strictEqual(result.command, "remove_watermark");
      assert.strictEqual(result.level, Number(level || 1));
      assert.strictEqual(result.level_name, level === "2" ? "AI去水印" : "自动去印");
      const sent = submits.slice(beforeCount);
      assert.deepStrictEqual(sent.map((item) => item.type).sort(), level === "2" ? ["94", "95"] : ["3", "8"]);
      for (const item of sent) {
        assert.strictEqual(JSON.parse(item.right_detail).function_id, "63390");
      }
      assert.ok(watermark.err.includes("消除水印 · 档位"));
      assert.ok(!watermark.err.includes("画质修复"));
      for (const item of result.results) assert.ok(item.result_url.startsWith(base));
    }

    events = []; mode = "http-parameter-failure";
    const parameterFailure = await capture(() => main(args(video), services));
    assert.strictEqual(parameterFailure.code, 3);
    assert.match(parameterFailure.err, /POST \/task\/submit.*参数错误.*HTTP 400.*code=10101/);
    assert.ok(!events.includes("query"), "rejected submit must not poll");
    assert.ok(!parameterFailure.err.includes("test-key"), "errors must not expose credentials");

    events = []; mode = "algorithm-failure";
    const algorithmFailure = await capture(() => main(args(video), services));
    assert.strictEqual(algorithmFailure.code, 3);
    assert.match(algorithmFailure.err, /PROCESS_IMAGE_ERROR.*code=29903.*task_id=task-/);
    const failedResult = JSON.parse(algorithmFailure.out).results[0];
    assert.strictEqual(failedResult.error_code, 29903);
    assert.match(failedResult.task_id, /^task-/);
    assert.ok(!events.includes("download"));
    queryCount = 0;

    events = []; mode = "download-failure";
    const linkOnly = await capture(() => main(args(photo), services));
    assert.strictEqual(linkOnly.code, 0, linkOnly.err);
    assert.ok(JSON.parse(linkOnly.out).results[0].result_url.startsWith(base));
    assert.ok(!events.includes("download"), "an unavailable download URL does not affect cloud completion");
    assert.ok(!linkOnly.err.includes("下载中"));
    assert.ok(!fs.existsSync(outDir));

    events = []; mode = "config-failure";
    const configFailure = await capture(() => main(args(photo), services));
    assert.strictEqual(configFailure.code, 1);
    assert.ok(configFailure.err.includes("配置暂不可用"));
    assert.deepStrictEqual(events, ["config"], "failed preflight must never upload/submit");

    // The CLI has no confirmed membership identity. Longer videos reach the server
    // without an invented VIP flag, and seconds still become integer milliseconds.
    for (const seconds of [61, 3600]) {
      events = []; mode = "success"; duration = seconds; queryCount = 0;
      const before = submits.length;
      const longVideo = await capture(() => main(args(video), services));
      assert.strictEqual(longVideo.code, 0, longVideo.err);
      assert.strictEqual(JSON.parse(longVideo.out).results[0].ok, true);
      assert.strictEqual(submits.length, before + 1);
      assert.strictEqual(submits.at(-1).duration, String(seconds * 1000));
      assert.ok(!Object.hasOwn(submits.at(-1), "is_vip"), "do not invent a VIP entitlement on submit");
      assert.deepStrictEqual(events, ["config", "upload", "submit", "query", "query"]);
    }

    events = []; mode = "normal-account-duration-rejection"; duration = 61;
    const beforeRejected = submits.length;
    const normalAccount = await capture(() => main(args(video), services));
    assert.strictEqual(normalAccount.code, 3, normalAccount.err);
    const normalFailure = JSON.parse(normalAccount.out).results[0];
    assert.strictEqual(normalFailure.ok, false);
    assert.ok(normalFailure.reason.includes("当前账号不是会员，视频时长不能超过60秒"),
      "authoritative account-duration rejection must reach the user unchanged");
    assert.ok(!Object.hasOwn(normalFailure, "result_url"));
    assert.strictEqual(submits.length, beforeRejected + 1, "account rejection must not retry a paid submission");
    assert.deepStrictEqual(events, ["config", "upload", "submit"], "rejected submit must not poll or recharge");

    events = []; mode = "success"; duration = 3600.001;
    const tooLong = await capture(() => main(args(video), services));
    assert.strictEqual(tooLong.code, 3);
    assert.ok(JSON.parse(tooLong.out).results[0].reason.includes("上限"));
    assert.deepStrictEqual(events, ["config"], "invalid media must never upload/submit");

    events = []; mode = "beans-failure";
    const rejected = await capture(() => main(args(photo), services));
    assert.strictEqual(rejected.code, 3);
    assert.ok(JSON.parse(rejected.out).results[0].reason.includes("美豆不足，请充值（code=7777）"));
    assert.deepStrictEqual(events, ["config", "upload", "submit"], "service rejection is shown without querying or resubmitting");
    console.log("cli flow: authorization, mixed media, polling, result links without downloads, config failure, unknown membership durations and server rejection passed");
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (savedKey === undefined) delete process.env.WINK_CLI_API_KEY; else process.env.WINK_CLI_API_KEY = savedKey;
    if (savedGnum === undefined) delete process.env.WINK_TASK_GNUM; else process.env.WINK_TASK_GNUM = savedGnum;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
