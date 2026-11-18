"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main, taskTypeFor, toolHelp, COMMANDS } = require("../src/cli");
const { WinkClient, taskState } = require("../src/wink_client");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-smart-erase-"));
const video = path.join(dir, "video.mp4"), image = path.join(dir, "image.jpg");
for (const file of [video, image]) fs.writeFileSync(file, "offline fixture");
async function invoke(level, options = {}) {
  const calls = [], submitted = [];
  const mediaType = options.image ? 1 : 2;
  const type = level === 3 ? 253 : options.image ? 228 : 230;
  const client = new WinkClient({ baseUrl: "https://example.invalid" });
  const forbidden = () => { throw Error("unexpected network or credential access"); };
  client.request = forbidden;
  client.withApiKey = () => client;
  client.aiTypeConfig = async () => { calls.push("config"); return { code: 0, data: options.unavailable
    ? [{ type: 3, content_type: 2, func_id: 63390 }]
    : [{ type, content_type: mediaType, func_id: level === 3 ? 63394 : 63393, max_time_normal: 900, max_time: 1200 }] }; };
  client.uploadFile = async () => { calls.push("upload"); return { resource_url: "https://example.invalid/input" }; };
  client.submit = async (url, p) => { calls.push("submit"); submitted.push(p); return { code: 0, data: { msg_id: "mock" } }; };
  client.query = async () => ({ code: 0, data: { result: { error_code: 0,
    parameter: { exist_watermark: false }, media_info_list: [{ media_data: "https://example.invalid/output" }] } } });
  const write = process.stdout.write, error = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = x => { out += x; return true; };
  process.stderr.write = x => { err += x; return true; };
  try {
    const code = await main(["remove_watermark", "--level", String(level), "--env", options.env || "beta",
      "--input", options.batch ? `${image},${video}` : options.image ? image : video,
      "--api-key", "offline", "--json"], {
      createClient: () => client,
      probeMedia: () => ({ width: 640, height: 360, size: 100, duration: options.duration ?? 600 }),
      auth: { readCredential: forbidden, writeCredential: forbidden, openBrowser: forbidden },
      tracking: { bind() {}, firstRun() {}, emit() {} },
    });
    return { code, out, err, calls, submitted };
  } finally { process.stdout.write = write; process.stderr.write = error; }
}
(async () => {
  assert.strictEqual(COMMANDS.remove_watermark.defaultLevel, 1);
  assert.strictEqual(taskTypeFor(1, "1", "remove_watermark").taskType, "8");
  assert.strictEqual(taskTypeFor(2, "2", "remove_watermark").taskType, "94");
  assert.throws(() => taskTypeFor(3, "1", "remove_watermark"), /不支持图片/);
  assert.match(toolHelp("remove_watermark"), /智能全消 Pro/);
  for (const [level, imageInput, expectedType, material] of [[3, false, "253", "63341"], [4, true, "228", "63331"], [4, false, "230", "63331"]]) {
    const r = await invoke(level, { image: imageInput });
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(r.calls, ["config", "upload", "submit"]);
    const p = r.submitted[0];
    assert.strictEqual(p.taskType, expectedType);
    assert.deepStrictEqual(JSON.parse(p.rightDetail), { source: "1", touch_type: "4", function_id: "633", material_id: material });
    assert.deepStrictEqual(JSON.parse(p.typeParams), { is_mirror: 0, ...(!imageInput ? { orientation_tag: 1 } : {}), userboxes: "" });
    const item = JSON.parse(r.out).results[0];
    assert.strictEqual(item.level_name, level === 3 ? "智能全消" : "智能全消 Pro");
    assert.strictEqual(item.result_url, "https://example.invalid/output");
  }
  for (const level of [3, 4]) {
    for (const options of [{ duration: 600.001 }, { duration: NaN }, { unavailable: true }, { unavailable: true, env: "release" }]) {
      const r = await invoke(level, options);
      assert.notStrictEqual(r.code, 0);
      assert.ok(!r.calls.includes("upload") && !r.calls.includes("submit"), r.err);
    }
  }
  const wrongMedia = await invoke(3, { image: true });
  assert.notStrictEqual(wrongMedia.code, 0);
  assert.ok(!wrongMedia.calls.includes("upload"));
  const batch = await invoke(4, { batch: true });
  assert.strictEqual(batch.code, 1);
  assert.match(batch.err, /不支持批量/);
  assert.deepStrictEqual(batch.calls, []);
  // A mixed batch keeps per-file rejection: skip images, submit the eligible video once.
  const mixed = await invoke(3, { batch: true });
  assert.strictEqual(mixed.submitted.length, 1);
  assert.strictEqual(JSON.parse(mixed.out).failed, 1);
  for (const taskType of [228, 230, 253]) {
    assert.strictEqual(taskState({ result: { error_code: 0, parameter: { exist_watermark: false } } }, { taskType }).phase, "finish");
    assert.strictEqual(taskState({ result: { error_code: 29903 } }, { taskType }).phase, "fail");
  }
  console.log("ok - smart erase media, tickets, limits, batch policy, environment config and result handling");
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
