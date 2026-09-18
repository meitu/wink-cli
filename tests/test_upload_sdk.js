"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  UploadClient,
  crc32Buffer,
  generateSignature,
} = require("../src/upload_sdk");
const {
  downloadResult,
  WinkClient,
  buildSubmitForm,
  buildQueryParams,
  buildAiTypeConfigParams,
  taskState,
  resultUrl,
  inferContentType,
  checkAiTypeSupport,
} = require("../src/wink_client");

const SAVED_ENVS = {};
function saveEnv(...names) {
  for (const name of names) SAVED_ENVS[name] = process.env[name];
}
function restoreEnv() {
  for (const name of Object.keys(SAVED_ENVS)) {
    if (SAVED_ENVS[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED_ENVS[name];
  }
}

function response(payload, status = 200) {
  return { status, body: Buffer.from(JSON.stringify(payload)), headers: {} };
}

function policy(overrides = {}) {
  return [{
    mtyun: {
      token: "access:sign:e30=",
      key: "wink/example.png",
      data: "https://cdn.example/input.png",
      url: "https://upload.example",
      backup_url: "https://backup.example",
      access_url: "https://cdn.example/input.png",
      chunk_size: 4,
      block_size: 6,
      thread_num: 2,
      ...overrides,
    },
    order: ["mtyun"],
  }];
}

async function testSignature() {
  const values = ["5", "wink", "media", "1.2.0.5", "", "", "false", "mac", "png"];
  assert.deepStrictEqual(
    generateSignature("upload/policy", values, 1788442928963),
    { sigTime: "1788442928963", sigVersion: "1.3", sig: "ac202631dfa06a63ff06bad7fe1463aa" },
  );
}

async function testFormUpload(directory) {
  const calls = [];
  const transport = {
    async request(method, url, options = {}) {
      calls.push({ method, url, ...options });
      return url.includes("upload/policy") ? response(policy()) : response({ hash: "etag" });
    },
  };
  const input = path.join(directory, "small.png");
  fs.writeFileSync(input, "small-file");
  const result = await new UploadClient({
    strategyHosts: ["https://strategy.example/"],
    formThreshold: 100,
  }, { transport }).uploadFile(input);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.implementation, "nodejs");
  assert.strictEqual(result.data.accessUrl, "https://cdn.example/input.png");
  const query = new URL(calls[0].url).searchParams;
  assert.strictEqual(query.get("app"), "wink");
  assert.strictEqual(query.get("type"), "media");
  assert.strictEqual(query.get("suffix"), "png");
  assert(calls[1].body.includes(Buffer.from('name="token"')));
  assert(calls[1].body.includes(Buffer.from('name="crc32"')));
  assert(calls[1].body.includes(Buffer.from("small-file")));
}

async function testChunkedUpload(directory) {
  const calls = [];
  const transport = {
    async request(method, url, options = {}) {
      calls.push({ method, url, ...options });
      if (url.includes("upload/policy")) return response(policy());
      if (url.includes("/mkblk/")) {
        return response({ ctx: `ctx-${options.body.toString("ascii")}`, crc32: crc32Buffer(options.body) });
      }
      if (url.includes("/bput/")) {
        const previous = url.split("/bput/")[1].split("/")[0];
        return response({ ctx: `${previous}+${options.body.toString("ascii")}`, crc32: crc32Buffer(options.body) });
      }
      if (url.includes("/mkfile/")) return response({ hash: "etag" });
      throw new Error(`unexpected URL: ${url}`);
    },
  };
  const input = path.join(directory, "large.bin");
  fs.writeFileSync(input, "abcdefghij");
  const result = await new UploadClient({
    strategyHosts: ["https://strategy.example/"],
    formThreshold: 0,
  }, { transport }).uploadFile(input);
  assert.strictEqual(result.ok, true);
  const mkfile = calls.find((call) => call.url.includes("/mkfile/"));
  assert.strictEqual(mkfile.body.toString(), "ctx-abcd+ef,ctx-ghij");
}

async function testSubmitProtocol() {
  // ---- buildSubmitForm 纯函数（显式注入 gnum，不触碰真实目录）----
  const defaults = { gnum: "900000001" };
  const form = buildSubmitForm("https://cdn.example/a b/视频.mp4?token=1&x=2", {}, defaults);
  assert.strictEqual(form.get("client_id"), "1189857724", "default client_id");
  assert.ok(form.get("version"), "version defaulted");
  assert.strictEqual(form.get("client_language"), "zh-Hans");
  assert.strictEqual(form.get("client_channel_id"), "mcp");
  assert.strictEqual(form.get("gnum"), "900000001");
  assert.strictEqual(form.get("type"), "11", "mp4 -> video task type 11 (inferred from content_type=2)");
  assert.strictEqual(form.get("ext_params"), "{}");
  assert.ok(JSON.parse(form.get("right_detail")).function_id, "right_detail JSON default");
  assert.strictEqual(form.get("content_type"), "2", "mp4 -> video");
  // 图片资源联动图片画质修复 type=12（confluence pageId=262381582）
  const imgForm = buildSubmitForm("https://cdn.example/x.jpg", {}, defaults);
  assert.strictEqual(imgForm.get("content_type"), "1", "jpg -> image content_type");
  assert.strictEqual(imgForm.get("type"), "12", "jpg -> image task type 12 (inferred)");
  assert.strictEqual(form.get("with_prepare"), "0", "no preprocess by default");
  // source_url 必须被 URL 编码（x-www-form-urlencoded：空格 -> +，中文 -> UTF-8 百分号）
  assert.strictEqual(form.get("source_url"), "https://cdn.example/a b/视频.mp4?token=1&x=2");
  assert.ok(form.toString().includes("source_url=https%3A%2F%2Fcdn.example%2Fa+b%2F"));
  assert.ok(form.toString().includes("%E8%A7%86%E9%A2%91"), "chinese chars percent-encoded");
  // 未提供的可选字段应省略
  for (const key of ["country_code", "cover_pic", "ticket", "group_task_id", "cut_range", "height", "width", "duration", "size", "is_test"]) {
    assert.strictEqual(form.get(key), null, `${key} omitted when unset`);
  }
  // ---- 显式 options 覆盖（含数字/字符串归一）----
  const over = buildSubmitForm("https://cdn.example/pic.png", {
    taskType: "88", clientId: "mac-9", version: "2.0.0.0", channelId: "wx",
    language: "en", withPrepare: 1, contentType: "1", isTest: 1,
    extParams: JSON.stringify({ task_name: "unit" }), rightDetail: "{}",
  }, defaults);
  assert.strictEqual(over.get("type"), "88");
  assert.strictEqual(over.get("client_id"), "mac-9");
  assert.strictEqual(over.get("version"), "2.0.0.0");
  assert.strictEqual(over.get("client_channel_id"), "wx");
  assert.strictEqual(over.get("with_prepare"), "1");
  assert.strictEqual(over.get("content_type"), "1");
  assert.strictEqual(over.get("is_test"), "1");
  assert.ok(over.get("ext_params").includes("unit"));
  // ---- 环境变量高于 defaults（buildSubmitForm 纯函数按 env 直读）----
  const saved = process.env.WINK_TASK_TYPE;
  process.env.WINK_TASK_TYPE = "77";
  try {
    const fromEnv = buildSubmitForm("https://cdn.example/x.jpg", {}, defaults);
    assert.strictEqual(fromEnv.get("type"), "77", "env overrides defaults");
    const fromOpt = buildSubmitForm("https://cdn.example/x.jpg", { taskType: "66" }, defaults);
    assert.strictEqual(fromOpt.get("type"), "66", "explicit option overrides env");
  } finally {
    if (saved === undefined) delete process.env.WINK_TASK_TYPE; else process.env.WINK_TASK_TYPE = saved;
  }
  // ---- WINK_CLIENT_ID 一处配置统一生效(登录 authUrl + 投递/查询/maat 通用参数)----
  saveEnv("WINK_CLIENT_ID");
  process.env.WINK_CLIENT_ID = "uni-9";
  try {
    assert.strictEqual(buildSubmitForm("https://cdn.example/x.jpg", {}, defaults).get("client_id"), "uni-9", "submit reads WINK_CLIENT_ID");
    assert.strictEqual(buildQueryParams("m-uni", {}, defaults).client_id, "uni-9", "query reads WINK_CLIENT_ID");
    const auth = new WinkClient({ baseUrl: "http://local" }).authUrl();
    assert.ok(auth.auth_url.includes("client_id=uni-9"), "login auth URL reads WINK_CLIENT_ID");
    const explicit = new WinkClient({ baseUrl: "http://local" }).authUrl(undefined, "mac-9");
    assert.ok(explicit.auth_url.includes("client_id=mac-9"), "explicit clientId still overrides env");
  } finally {
    restoreEnv();
  }
  // ---- ai_type_config 参数与投递前校验（config type 值域:1=视频 2=图片,pre 实测）----
  const cfgParams = buildAiTypeConfigParams({ type: "12" }, defaults);
  assert.strictEqual(cfgParams.type, "12", "ai_type_config carries type when given");
  assert.strictEqual(cfgParams.client_id, "1189857724", "ai_type_config shares client params");
  assert.ok(!("msg_id" in cfgParams), "ai_type_config has no msg_id");
  assert.ok(!("type" in buildAiTypeConfigParams({}, defaults)), "type omitted when unset");
  const cfgList = { data: [
    { type: 1, name: "画质修复-高清(视频)", content_type: 2, min_time: 1, max_time_normal: 60, max_time: 3600 },
    { type: 2, name: "画质修复-高清(图片)", content_type: 1 },
  ] };
  assert.strictEqual(checkAiTypeSupport(cfgList, { type: "12", contentType: "1" }).ok, true, "image input ok — submit type 12 mapped to config type 2");
  assert.strictEqual(checkAiTypeSupport(cfgList, { type: "12", contentType: "2" }).ok, false, "video input rejected for the image feature");
  assert.strictEqual(checkAiTypeSupport(cfgList, { type: "2", contentType: "1" }).ok, true, "config value space (2) matches directly");
  assert.strictEqual(checkAiTypeSupport(cfgList, { type: "99" }).ok, false, "unknown type rejected");
  assert.strictEqual(checkAiTypeSupport(cfgList, { contentType: "2" }).ok, true, "content_type-only matching picks the video feature");
  const vid = checkAiTypeSupport(cfgList, { type: "11", contentType: "2", durationSeconds: 120, isVip: false });
  assert.strictEqual(vid.ok, false, "120s exceeds max_time_normal=60 for non-vip");
  assert.ok(checkAiTypeSupport(cfgList, { type: "11", contentType: "2", durationSeconds: 120, isVip: true }).ok, "120s ok for vip (max_time=3600)");
  // ---- inferContentType ----
  assert.strictEqual(inferContentType("https://x/y.MOV?e=1"), "2");
  assert.strictEqual(inferContentType("https://x/y.jpeg"), "1");
  assert.strictEqual(inferContentType("https://x/noext"), undefined);
  console.log("ok - submit form protocol (defaults/encoding/override/env/content_type)");
}

async function testQueryProtocol() {
  // ---- buildQueryParams（GET /task/query 查询参数，显式注入 gnum 防触碰真实目录）----
  const defaults = { gnum: "900000001" };
  const params = buildQueryParams("unit-msg", {}, defaults);
  assert.strictEqual(params.msg_id, "unit-msg");
  assert.strictEqual(params.client_id, "1189857724", "default client_id");
  assert.ok(params.version, "version defaulted");
  assert.strictEqual(params.client_language, "zh-Hans");
  assert.strictEqual(params.client_channel_id, "mcp");
  assert.strictEqual(params.gnum, "900000001");
  for (const key of ["country_code", "is_test"]) {
    assert.strictEqual(params[key], undefined, `${key} omitted when unset`);
  }
  assert.throws(() => buildQueryParams(""), /msg_id is required/, "empty msg_id rejected");
  assert.throws(() => buildQueryParams(null, {}, defaults), /msg_id is required/, "null msg_id rejected");
  // ---- 显式 options 覆盖 ----
  const over = buildQueryParams("m2", { clientId: "mac-1", gnum: "900000002", isTest: 1, clientLanguage: "en" }, defaults);
  assert.strictEqual(over.client_id, "mac-1");
  assert.strictEqual(over.gnum, "900000002");
  assert.strictEqual(over.is_test, "1");
  assert.strictEqual(over.client_language, "en");
  // ---- 环境变量高于 defaults ----
  saveEnv("WINK_TASK_GNUM");
  process.env.WINK_TASK_GNUM = "900000003";
  try {
    assert.strictEqual(buildQueryParams("m3", {}, defaults).gnum, "900000003", "env overrides defaults");
    assert.strictEqual(buildQueryParams("m4", { gnum: "900000004" }, defaults).gnum, "900000004", "option overrides env");
  } finally {
    restoreEnv();
  }

  // ---- taskState（旧 status 字段 / 新 result 块终态推断）----
  assert.strictEqual(taskState({ status: "finish" }).phase, "finish");
  assert.strictEqual(taskState({ status: "failed" }).phase, "fail");
  assert.strictEqual(taskState({ status: "processing" }).phase, "running");
  assert.strictEqual(taskState(null).phase, "unknown");
  // 新协议完成：result 块 + error_code 0
  const finished = taskState({
    msg_id: "x",
    result: { error_code: 0, error_msg: "success", media_info_list: [{ media_data: "https://cdn/r.jpg" }] },
  });
  assert.strictEqual(finished.phase, "finish");
  assert.strictEqual(finished.error_code, 0);
  // 新协议失败：result.error_code != 0
  const failed = taskState({ result: { error_code: 1001, error_msg: "boom" } });
  assert.strictEqual(failed.phase, "fail");
  assert.match(failed.reason, /boom|1001/);
  // 新协议进行中：无 result / result 为 null / 空串
  assert.strictEqual(taskState({ msg_id: "x", remaining_elapsed: 30 }).phase, "running");
  assert.strictEqual(taskState({ result: null }).phase, "running");
  assert.strictEqual(taskState({ result: "" }).phase, "running");
  // 顶层 data.error_code 非 0 → 失败
  assert.strictEqual(taskState({ error_code: 9, error_msg: "denied" }).phase, "fail");

  // 处理中：result 块已出现但 error_code=29901 / error_msg="NOT_RESULT" → running（pre 实测）
  const pending29901 = taskState({
    msg_id: "x",
    result: { error_code: 29901, error_msg: "NOT_RESULT", media_info_list: null },
  });
  assert.strictEqual(pending29901.phase, "running", "29901/NOT_RESULT is pending, not failure");
  assert.strictEqual(
    taskState({ result: { error_code: 0, error_msg: "NOT_RESULT" } }).phase,
    "running",
    "NOT_RESULT msg alone also means pending",
  );

  // 算法结果必须优先于可能指向原素材的顶层 url。
  assert.strictEqual(resultUrl({ data: {
    url: "https://cdn/original.jpg",
    result_url: "https://cdn/legacy.jpg",
    result: { url: "https://cdn/alternate.jpg", media_info_list: [{ media_data: "https://cdn/enhanced.jpg" }] },
  } }), "https://cdn/enhanced.jpg");
  assert.strictEqual(resultUrl({ data: {
    url: "https://cdn/original.jpg",
    result: { media_info_list: [{ media_data: "invalid", url: "https://cdn/enhanced.jpg" }] },
  } }), "https://cdn/enhanced.jpg");
  assert.strictEqual(resultUrl({ data: {
    url: "https://cdn/original.jpg", result: { url: "https://cdn/enhanced.jpg" },
  } }), "https://cdn/enhanced.jpg");
  // 兼容只提供旧结果字段的响应。
  assert.strictEqual(resultUrl({ data: { url: "https://cdn/out.jpg" } }), "https://cdn/out.jpg");
  assert.strictEqual(
    resultUrl({ data: { result: { media_info_list: [{ media_data: "https://cdn/m.jpg" }] } } }),
    "https://cdn/m.jpg",
  );
  assert.strictEqual(resultUrl({ data: { result_url: "https://cdn/legacy.mov" } }), "https://cdn/legacy.mov");
  assert.throws(() => resultUrl({ data: {} }), /no valid result media URL/);
  console.log("ok - query protocol (params/state inference/result url)");
}

async function testUploadSubmitDownload(directory) {
  saveEnv("WINK_TASK_GNUM");
  process.env.WINK_TASK_GNUM = "900000005";
  let baseUrl = "";
  const received = { submitCt: "", submitBody: "", queryUrls: [], queryCount: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/upload/policy")) {
        res.end(JSON.stringify(policy({ url: `${baseUrl}/upload`, access_url: `${baseUrl}/resource.mp4` })));
      } else if (req.url.startsWith("/upload")) {
        res.end(JSON.stringify({ url: `${baseUrl}/resource.mp4` }));
      } else if (req.url.startsWith("/task/submit")) {
        received.submitCt = req.headers["content-type"] || "";
        received.submitBody = Buffer.concat(chunks).toString("utf8");
        res.end(JSON.stringify({ code: 0, data: { msg_id: "local-msg", error_code: 0 } }));
      } else if (req.url.startsWith("/task/query")) {
        received.queryUrls.push(req.url);
        received.queryCount += 1;
        if (received.queryCount === 1) {
          // 新协议进行中：无 result 块
          res.end(JSON.stringify({ code: 0, data: { msg_id: "local-msg", remaining_elapsed: 2 } }));
        } else {
          // 新协议完成：data.result + 顶层 data.url
          res.end(JSON.stringify({
            code: 0,
            data: {
              msg_id: "local-msg",
              url: `${baseUrl}/result.mov`,
              result: {
                error_code: 0,
                error_msg: "success",
                media_info_list: [{ media_data: `${baseUrl}/result.mov` }],
              },
            },
          }));
        }
      } else if (req.url === "/result.mov") {
        res.setHeader("Content-Type", "video/quicktime");
        res.end(Buffer.from("fake-mov-content"));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  const input = path.join(directory, "cli-input.mp4");
  const outputDirectory = path.join(directory, "results");
  fs.writeFileSync(input, "local-video");
  fs.mkdirSync(outputDirectory);
  try {
    const client = new WinkClient({
      baseUrl,
      apiKey: "test-key",
      accessToken: "",
      log: () => {},
    });
    const uploaded = await client.uploadFile(input, { strategyHosts: [`${baseUrl}/`] });
    const processed = await client.run(uploaded.resource_url, { contentType: uploaded.content_type, interval: 0.001, timeout: 30 });
    assert.strictEqual(processed.code, 0);
    const downloaded = await downloadResult(resultUrl(processed), path.join(outputDirectory, "result.mov"), {});
    assert.strictEqual(uploaded.upload.implementation, "nodejs");
    assert.strictEqual(fs.readFileSync(downloaded.path, "utf8"), "fake-mov-content");
    // submit 走新 form 协议
    assert.strictEqual(received.submitCt, "application/x-www-form-urlencoded");
    const body = new URLSearchParams(received.submitBody);
    assert.strictEqual(body.get("source_url"), `${baseUrl}/resource.mp4`);
    assert.strictEqual(body.get("content_type"), "2", "mp4 resource -> content_type=2");
    assert.strictEqual(body.get("gnum"), "900000005");
    assert.strictEqual(body.get("with_prepare"), "0");
    assert.ok(body.get("type") && body.get("client_id") && body.get("version"), "required fields present");
    // 轮询用 submit 返回的 msg_id，走新客户端查询协议（msg_id + 通用传参，无 task_id）
    assert.ok(received.queryUrls.length >= 2, `polls until finish (was ${received.queryUrls.length})`);
    const firstQuery = new URL(`http://local${received.queryUrls[0]}`);
    assert.strictEqual(firstQuery.searchParams.get("msg_id"), "local-msg");
    assert.ok(!firstQuery.searchParams.has("task_id"), "no legacy task_id param");
    assert.strictEqual(firstQuery.searchParams.get("client_id"), "1189857724");
    assert.strictEqual(firstQuery.searchParams.get("gnum"), "900000005");
    assert.ok(firstQuery.searchParams.get("version"), "client version present");
  } finally {
    restoreEnv();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wink-node-test-"));
  try {
    await testSignature();
    await testFormUpload(directory);
    await testChunkedUpload(directory);
    await testSubmitProtocol();
    await testQueryProtocol();
    await testUploadSubmitDownload(directory);
    process.stdout.write("node protocol tests: 6 passed\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
