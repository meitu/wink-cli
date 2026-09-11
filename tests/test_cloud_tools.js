"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { main } = require("../src/cli");
const { prepareTool } = require("../src/cloud_tools");
const { WinkClient, checkAiTypeSupport } = require("../src/wink_client");
const rows = require("./fixtures/cf-cloud-tools-v5.json").slice(1);

async function capture(fn) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = value => { out += value; return true; };
  process.stderr.write = value => { err += value; return true; };
  try { return { code: await fn(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
(async () => {
  const savedGnum = process.env.WINK_TASK_GNUM;
  process.env.WINK_TASK_GNUM = "900000009";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-all-tools-"));
  const image = path.join(dir, "input.jpg"), video = path.join(dir, "input.mp4"), reference = path.join(dir, "reference.png");
  for (const file of [image, video, reference]) fs.writeFileSync(file, "media");
  let base, submitted, uploads = [], configs, calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(req.url.split("?")[0]);
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/task/ai_type_config")) return res.end(JSON.stringify({ code: 0, data: configs }));
    if (req.url === "/task/submit") { submitted = Object.fromEntries(new URLSearchParams(body)); return res.end(JSON.stringify({ code: 0, data: { msg_id: "mock-task" } })); }
    if (req.url.startsWith("/task/query")) return res.end(JSON.stringify({ code: 0, data: { result: { error_code: 0 }, url: base + "/result.jpg" } }));
    if (req.url === "/result.jpg") return res.end("processed");
    res.statusCode = 404; res.end();
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const services = {
      createClient: options => {
        const client = new WinkClient({ ...options, baseUrl: base });
        client.withApiKey = key => {
          const authed = new WinkClient({ ...options, baseUrl: base, apiKey: key });
          authed.uploadFile = async (file, options) => { uploads.push({ file, test: options.test }); options.onProgress(0.5); return { resource_url: base + "/" + path.basename(file) }; };
          return authed;
        };
        return client;
      },
      probeMedia: file => ({ width: 100, height: 100, size: 5, ...(file.endsWith("mp4") ? { duration: 5 } : {}) }),
    };
    const extras = {
      resolution_repair: ["--sr-mode", "3"], denoise: ["--strength", "high"], night_scene: ["--strength", "median"],
      color_unite: ["--reference", reference], cartoon: ["--style", "xinhaicheng", "--formula-type", "1"],
      ai_translation: ["--target-language", "en"], ai_beauty: ["--retouch-params", '{"smoothing":0.5}'], video_frame: ["--fps", "60"],
    };
    let count = 0;
    for (const row of rows) {
      const [, command, level, name, media, type] = row;
      const contentType = media === "视频" ? "2" : "1";
      const input = contentType === "2" ? video : image;
      let ext = command === "resolution_repair" ? "3" : command === "denoise" ? "high" : command === "night_scene" ? "median" : command === "cartoon" && contentType === "2" ? "xinhaicheng" : undefined;
      configs = [{ type, content_type: Number(contentType), ext_value: ext, func_id: 999, min_time: 1, max_time_normal: 60 }];
      // Ensure matching does not pick an earlier different strength, media, or local-only config.
      if (ext) configs.unshift({ type, content_type: Number(contentType), ext_value: "wrong", func_id: 888 });
      configs.unshift({ type, content_type: Number(contentType), ext_value: ext, is_local_process: 1, func_id: 777 });
      const args = [command, "--input", input, "--output", path.join(dir, "out"), "--env", "pre", "--api-key", "offline-test", "--json", ...(extras[command] || [])];
      if (["picture_quality", "remove_watermark", "video_frame"].includes(command)) args.push("--level", level);
      if (command === "old_photo") args.push("--variant", type === "161" ? "quality" : type === "164" ? "shared" : "standard");
      submitted = null; uploads = []; calls = [];
      const result = await capture(() => main(args, services));
      assert.strictEqual(result.code, 0, `${name}: ${result.err}`);
      assert.strictEqual(submitted.type, type, name);
      assert.strictEqual(submitted.content_type, contentType, name);
      assert.strictEqual(JSON.parse(submitted.right_detail).function_id, "999");
      assert.ok(uploads.every(x => x.test === true));
      assert.deepStrictEqual(calls, ["/task/ai_type_config", "/task/submit", "/task/query"]);
      const params = JSON.parse(submitted.type_params);
      if (command === "resolution_repair") assert.strictEqual(params.sr_mode, 3);
      if (command === "denoise") assert.strictEqual(params.denoise_level, "high");
      if (command === "night_scene") assert.strictEqual(params.denoise_level, "median");
      if (command === "video_frame") assert.strictEqual(params.targ_fps, 60);
      if (command === "color_unite") { assert.strictEqual(submitted.cover_pic, base + "/reference.png"); assert.strictEqual(params.cover_pic, submitted.cover_pic); assert.strictEqual(uploads[0].file, reference); }
      if (command === "cartoon") { assert.strictEqual(submitted.formula_style, "xinhaicheng"); assert.strictEqual(params.formula_type, "1"); if (contentType === "1") assert.strictEqual(params.preview, 1); }
      if (command === "ai_translation") assert.strictEqual(JSON.parse(params.translate_params).target_language, "en");
      if (command === "ai_beauty") assert.strictEqual(JSON.parse(params.retouch_ai_params).smoothing, 0.5);
      if (command === "old_photo") assert.strictEqual(JSON.parse(params.workflow_params).basic_repair, 1);
      assert.strictEqual(JSON.parse(result.out).results[0].result_url, base + "/result.jpg");
      assert.ok(!calls.includes("/result.jpg"), "never download cloud results");
      assert.ok(!fs.existsSync(path.join(dir, "out")));
      count++;
    }
    // Runtime config absence and unsupported media must stop before upload/submit.
    configs = [{ type: 122, content_type: 1 }]; uploads = []; calls = [];
    const unavailable = await capture(() => main(["old_photo", "--variant", "shared", "--input", image, "--output", dir, "--api-key", "offline", "--json"], services));
    assert.strictEqual(unavailable.code, 3); assert.match(unavailable.err, /type=164/); assert.deepStrictEqual(uploads, []); assert.deepStrictEqual(calls, ["/task/ai_type_config"]);
    for (const [command, flags, error] of [
      ["ai_translation", {}, /target-language/], ["ai_beauty", {}, /retouch-params/], ["color_unite", {}, /reference/],
      ["cartoon", { style: "x" }, /formula-type/], ["video_frame", { fps: "60", factor: "2" }, /不能同时/],
      ["denoise", { strength: "extreme" }, /可用值/], ["denoise", { strenght: "high" }, /未知选项/], ["old_photo", { "workflow-params": "[]" }, /JSON/],
    ]) assert.throws(() => prepareTool(command, flags), error);
    const file = path.join(dir, "effect.json"); fs.writeFileSync(file, '{"skin":1}');
    assert.deepStrictEqual(JSON.parse(prepareTool("ai_beauty", { "retouch-params": "@" + file }).params.retouch_ai_params), { skin: 1 });
    assert.strictEqual(checkAiTypeSupport([{ type: 2, content_type: 1 }], { type: 12, contentType: 1, strictType: true }).ok, false);
    assert.strictEqual(prepareTool("resolution_repair", {}).params.sr_mode, 1);
    assert.strictEqual(prepareTool("denoise", {}).params.denoise_level, "low");
    const limited = [{ type: 10, content_type: 1, input_limit: { formats: ["jpg"], max_size_bytes: 100, max_edge: 50, max_pixels: 2000 } }];
    for (const input of [{ extension: "png" }, { size: 101 }, { width: 51, height: 1 }, { width: 50, height: 50 }]) {
      assert.strictEqual(checkAiTypeSupport(limited, { type: 10, contentType: 1, ...input }).ok, false);
    }
    assert.strictEqual(checkAiTypeSupport(limited, { type: 10, contentType: 1, extension: "jpg", size: 99, width: 40, height: 40 }).ok, true);
    console.log(`cloud tools: ${count} CF mappings passed through config/upload/submit/query/result URL; parameter and unavailable-config checks passed`);
  } finally {
    if (savedGnum === undefined) delete process.env.WINK_TASK_GNUM;
    else process.env.WINK_TASK_GNUM = savedGnum;
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
