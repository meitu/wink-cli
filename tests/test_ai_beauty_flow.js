"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { main } = require("../src/cli");
const { WinkClient } = require("../src/wink_client");

async function capture(fn) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = value => { out += value; return true; };
  process.stderr.write = value => { err += value; return true; };
  try { return { code: await fn(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-beauty-flow-"));
  const image = path.join(dir, "image.jpg"), video = path.join(dir, "video.mp4");
  for (const file of [image, video]) fs.writeFileSync(file, "offline beauty fixture");
  const identity = {
    WINK_TASK_GNUM: "9223372036854775807", WINK_CLIENT_ID: "beauty-test-client",
    WINK_TASK_VERSION: "1.2 测试+&", WINK_TASK_LANGUAGE: "zh-Hans 中文",
    WINK_TASK_CHANNEL_ID: "offline channel+&", WINK_TASK_COUNTRY_CODE: "CN",
  };
  const savedEnv = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
  Object.assign(process.env, identity);
  const style = overrides => ({
    material_id: 67201, name: "自然风格", media_type_limit: 0,
    material_conf: { parameter: { "face_key": { strength: 0.25, enabled: true }, exact_flag: "0" }, ignored_metadata: "not an algorithm parameter" },
    ...overrides,
  });
  const original = style();
  const listPath = "/material/ai_beauty/list";
  const nextCursor = "下一页 +/&?=";
  let base, pages, configs, requests, events, uploads, submits, serverErrors, clientUrls, listFailure;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      requests.push(url);
      events.push(url.pathname);
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.strictEqual(req.headers.api_key, "offline-ai-beauty");
      assert.strictEqual(req.headers["access-token"], "offline-access-token");
      assert.strictEqual(req.headers["mt-gv"], undefined);
      assert.strictEqual(url.searchParams.has("gender"), false, "gender is a local style selector, never an API parameter");
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === listPath) {
        assert.strictEqual(req.method, "GET");
        assert.strictEqual(body, "");
        assert.strictEqual(url.searchParams.get("count"), "50");
        for (const key of ["sig", "sigTime", "sigVersion"]) assert.strictEqual(url.searchParams.has(key), false);
        const names = { client_id: "WINK_CLIENT_ID", version: "WINK_TASK_VERSION", client_language: "WINK_TASK_LANGUAGE", client_channel_id: "WINK_TASK_CHANNEL_ID", country_code: "WINK_TASK_COUNTRY_CODE", gnum: "WINK_TASK_GNUM" };
        for (const [field, key] of Object.entries(names)) assert.strictEqual(url.searchParams.get(field), identity[key], field + " round-trips through URL encoding");
        if (listFailure) {
          res.statusCode = listFailure.status || 200;
          return res.end(JSON.stringify(listFailure.payload));
        }
        const page = pages.get(url.searchParams.get("cursor") || "");
        assert.ok(page, "only server-provided cursors are requested");
        return res.end(JSON.stringify({ code: 0, data: page }));
      }
      if (url.pathname === "/task/ai_type_config") return res.end(JSON.stringify({ code: 0, data: configs }));
      if (url.pathname === "/task/submit") {
        assert.strictEqual(req.method, "POST");
        const submitted = Object.fromEntries(new URLSearchParams(body));
        assert.strictEqual(Object.hasOwn(submitted, "gender"), false);
        submits.push(submitted);
        return res.end(JSON.stringify({ code: 0, data: { msg_id: "beauty-" + submits.length } }));
      }
      if (url.pathname === "/task/query") {
        const taskId = url.searchParams.get("msg_id");
        assert.match(taskId, /^beauty-[1-9]\d*$/);
        return res.end(JSON.stringify({ code: 0, data: { result: { error_code: 0, media_info_list: [{ media_data: base + "/results/" + taskId + ".jpg" }] } } }));
      }
      throw new Error("unexpected request, login or download: " + url.pathname);
    } catch (error) {
      serverErrors.push(error.message);
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 500, message: error.message }));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const forbidAuth = () => { throw new Error("offline tests must not log in or read credentials"); };
    const services = {
      auth: { openBrowser: forbidAuth, readCredential: forbidAuth, writeCredential: forbidAuth },
      createClient: options => {
        clientUrls.push(options.baseUrl);
        const client = new WinkClient({ ...options, baseUrl: base });
        client.authUrl = forbidAuth;
        client.exchange = forbidAuth;
        client.withApiKey = apiKey => {
          const authed = new WinkClient({ ...options, baseUrl: base, apiKey, accessToken: "offline-access-token" });
          authed.uploadFile = async (file, uploadOptions) => {
            events.push("upload");
            uploads.push({ file, test: uploadOptions.test });
            uploadOptions.onProgress(0.5);
            return { resource_url: base + "/uploads/" + path.basename(file) };
          };
          return authed;
        };
        return client;
      },
      probeMedia: file => ({ width: 1920, height: 1080, size: 21, ...(file === video ? { duration: 5 } : {}) }),
    };
    function reset(items = [style()]) {
      pages = new Map([["", { item_list: items, cursor: "" }]]);
      configs = [
        { type: 40, content_type: 1, func_id: 12345 },
        { type: 39, content_type: 2, func_id: 12345, min_time: 1, max_time: 60, max_time_normal: 60 },
      ];
      requests = []; events = []; uploads = []; submits = []; serverErrors = []; clientUrls = []; listFailure = null;
    }
    async function invoke(flags, input, env = "pre") {
      const result = await capture(() => main([
        "ai_beauty", "--env", env, "--api-key", "offline-ai-beauty", "--json",
        ...(input ? ["--input", input] : []), ...flags,
      ], services));
      assert.deepStrictEqual(serverErrors, [], "requests use the documented local fixture routes");
      return result;
    }
    function assertSubmission(index, file, useStyle, hair, chin) {
      const submit = submits[index];
      const isVideo = file === video;
      assert.strictEqual(submit.type, isVideo ? "39" : "40");
      assert.strictEqual(submit.content_type, isVideo ? "2" : "1");
      assert.strictEqual(submit.source_url, base + "/uploads/" + path.basename(file));
      const params = JSON.parse(submit.type_params);
      assert.strictEqual(typeof params.retouch_ai_params, "string");
      const expected = {};
      if (useStyle) expected.beauty_style = original.material_conf.parameter;
      if (hair) expected.hair_silky = { media_mode: isVideo ? 1 : 0 };
      if (chin) expected.beauty_double_chin = { media_mode: isVideo ? 1 : 0 };
      assert.deepStrictEqual(JSON.parse(params.retouch_ai_params), expected);
      assert.deepStrictEqual(params, { retouch_ai_params: JSON.stringify(expected), is_mirror: "0", orientation_tag: 1, preview: 0 });
      assert.deepStrictEqual(JSON.parse(submit.right_detail), {
        source: "1", touch_type: "4", function_id: "672",
        material_id: [...(useStyle ? ["67201"] : []), ...(hair ? ["67206"] : []), ...(chin ? ["67207"] : [])].join(","),
      });
    }

    // 风格查询不要求输入、不读取账号缓存，不调用能力配置、上传和处理接口。
    for (const [env, host, isTest] of [["pre", "precliapi", "1"], ["beta", "betacliapi", "0"], ["release", "cliapi", "0"]]) {
      reset();
      const listed = await invoke(["--list-styles"], undefined, env);
      assert.strictEqual(listed.code, 0, listed.err);
      assert.deepStrictEqual(JSON.parse(listed.out), { ok: true, command: "ai_beauty", env, styles: [original] });
      assert.deepStrictEqual(clientUrls, [`https://${host}-winkcut.meitu.com`]);
      assert.strictEqual(requests[0].searchParams.get("is_test"), isTest);
      assert.strictEqual(requests[0].searchParams.has("cursor"), false);
      assert.deepStrictEqual(events, [listPath]);
      assert.deepStrictEqual(uploads, []);
      assert.deepStrictEqual(submits, []);
    }

    reset();
    pages = new Map([
      ["", { item_list: [style({ material_id: 67202, name: "首页风格" })], cursor: nextCursor }],
      [nextCursor, { item_list: [style()] }],
    ]);
    const paginated = await invoke(["--list-styles"]);
    assert.strictEqual(paginated.code, 0, paginated.err);
    assert.deepStrictEqual(JSON.parse(paginated.out).styles.map(item => item.material_id), [67202, 67201]);
    assert.strictEqual(requests[1].searchParams.get("cursor"), nextCursor);
    assert.deepStrictEqual(events, [listPath, listPath]);

    const secondPageStyles = pages;
    reset();
    pages = secondPageStyles;
    const selectedPage = await invoke(["--style", "67201"], image);
    assert.strictEqual(selectedPage.code, 0, selectedPage.err);
    assertSubmission(0, image, true, false, false);
    assert.deepStrictEqual(events, [listPath, listPath, "/task/ai_type_config", "upload", "/task/submit", "/task/query"]);

    reset();
    const readable = await capture(() => main(["ai_beauty", "--list-styles", "--api-key", "offline-ai-beauty"], services));
    assert.strictEqual(readable.code, 0, readable.err);
    assert.match(readable.out, /67201/);
    assert.match(readable.out, /自然风格/);
    assert.deepStrictEqual(serverErrors, []);
    assert.deepStrictEqual(events, [listPath]);

    // 两种媒体分别覆盖风格与两个附加开关的四种组合。
    for (const file of [image, video]) {
      for (const [hair, chin] of [[false, false], [true, false], [false, true], [true, true]]) {
        reset();
        const result = await invoke(["--style", "67201", ...(hair ? ["--hair-silky"] : []), ...(chin ? ["--beauty-double-chin"] : [])], file);
        assert.strictEqual(result.code, 0, result.err);
        assertSubmission(0, file, true, hair, chin);
        assert.deepStrictEqual(events, [listPath, "/task/ai_type_config", "upload", "/task/submit", "/task/query"]);
        assert.deepStrictEqual(uploads, [{ file, test: true }]);
        assert.strictEqual(JSON.parse(result.out).results[0].result_url, base + "/results/beauty-1.jpg");
      }
      for (const [hair, chin] of [[true, false], [false, true], [true, true]]) {
        reset([]);
        const result = await invoke([...(hair ? ["--hair-silky"] : []), ...(chin ? ["--beauty-double-chin"] : [])], file);
        assert.strictEqual(result.code, 0, result.err);
        assertSubmission(0, file, false, hair, chin);
      }
    }

    // 批处理中每个文件独立计算 media_mode，不修改服务端下发的风格参数。
    reset();
    const batch = await invoke(["--style", "67201", "--hair-silky", "--beauty-double-chin"], `${image},${video}`);
    assert.strictEqual(batch.code, 0, batch.err);
    assert.strictEqual(submits.length, 2);
    assertSubmission(0, image, true, true, true);
    assertSubmission(1, video, true, true, true);
    assert.deepStrictEqual(pages.get("").item_list, [original]);
    assert.deepStrictEqual(events, [listPath, "/task/ai_type_config", "upload", "/task/submit", "/task/query", "upload", "/task/submit", "/task/query"]);

    // 服务端列表错误保留错误信息，并在上传、计费投递之前停止。
    for (const status of [200, 503]) {
      reset();
      listFailure = { status, payload: { code: 10111, message: "原始列表错误：会话失效，请重新登录" } };
      const failure = await invoke(["--style", "67201"], image);
      assert.notStrictEqual(failure.code, 0);
      assert.match(failure.err, /原始列表错误：会话失效，请重新登录/);
      assert.match(failure.err, /10111/);
      assert.deepStrictEqual(events, [listPath]);
      assert.deepStrictEqual(uploads, []);
      assert.deepStrictEqual(submits, []);
    }
    for (const [id, items] of [
      ["99999", [style()]],
      ...["bad JSON", [], {}, null].map(parameter => ["67201", [style({ material_conf: { parameter } })]]),
    ]) {
      reset(items);
      const failure = await invoke(["--style", id], image);
      assert.notStrictEqual(failure.code, 0, failure.out);
      assert.deepStrictEqual(uploads, [], "unknown style or invalid parameters cannot upload");
      assert.deepStrictEqual(submits, []);
      assert.deepStrictEqual(events, [listPath]);
    }

    for (const [limit, allowedFile, rejectedFile] of [[1, image, video], [2, video, image]]) {
      reset([style({ media_type_limit: limit })]);
      const limited = await invoke(["--style", "67201"], `${image},${video}`);
      assert.strictEqual(limited.code, 2, limited.err);
      const results = JSON.parse(limited.out).results;
      assert.strictEqual(results.find(item => item.file === rejectedFile).ok, false);
      assert.strictEqual(results.find(item => item.file === allowedFile).ok, true);
      assert.deepStrictEqual(uploads.map(item => item.file), [allowedFile]);
      assert.strictEqual(submits.length, 1);
      assertSubmission(0, allowedFile, true, false, false);
    }

    reset();
    configs = [{ type: 12, content_type: 1, func_id: 672 }];
    const noConfig = await invoke(["--style", "67201"], image);
    assert.strictEqual(noConfig.code, 3);
    assert.deepStrictEqual(events, [listPath, "/task/ai_type_config"]);
    assert.deepStrictEqual(uploads, []);
    assert.deepStrictEqual(submits, []);

    for (const flags of [[], ["--style"], ["--retouch-params", '{"skin":1}']]) {
      reset();
      const invalid = await invoke(flags, image);
      assert.notStrictEqual(invalid.code, 0);
      assert.deepStrictEqual(events, []);
      assert.deepStrictEqual(clientUrls, []);
      if (flags[0] === "--retouch-params") assert.match(invalid.err, /retouch-params.*style/);
    }

    // 单横、双横及等号写法均选取明确性别名称，不把 female 误选为 male。
    const male = style({ material_id: 67231, name: "Male 自然风格", material_conf: { parameter: { male_only: 0.31 } } });
    const female = style({ material_id: "67232", name: "Female 清透风格", material_conf: { parameter: { female_only: 0.32 } } });
    function assertGenderResult(result, index, candidate, gender, file, hair = false, chin = false) {
      const output = JSON.parse(result.out).results[index];
      assert.deepStrictEqual(output.beauty_style, { material_id: candidate.material_id, name: candidate.name, gender });
      const submitted = submits[index];
      const expected = { beauty_style: candidate.material_conf.parameter };
      if (hair) expected.hair_silky = { media_mode: file === video ? 1 : 0 };
      if (chin) expected.beauty_double_chin = { media_mode: file === video ? 1 : 0 };
      assert.strictEqual(submitted.type, file === video ? "39" : "40");
      assert.deepStrictEqual(JSON.parse(submitted.type_params), {
        is_mirror: "0", orientation_tag: 1, preview: 0, retouch_ai_params: JSON.stringify(expected),
      });
      assert.deepStrictEqual(JSON.parse(submitted.right_detail), {
        source: "1", touch_type: "4", function_id: "672",
        material_id: [String(candidate.material_id), ...(hair ? ["67206"] : []), ...(chin ? ["67207"] : [])].join(","),
      });
    }
    for (const [flags, gender, candidate] of [
      [["-gender", "male"], "male", male], [["-gender=female"], "female", female],
      [["--gender", "male"], "male", male], [["--gender=female"], "female", female],
    ]) {
      reset([style({ name: "柔和风格" }), female, male]);
      const selected = await invoke(flags, image);
      assert.strictEqual(selected.code, 0, selected.err);
      assertGenderResult(selected, 0, candidate, gender, image);
      assert.deepStrictEqual(events, [listPath, "/task/ai_type_config", "upload", "/task/submit", "/task/query"]);
    }

    // 复制参数中的空白和零宽字符仅用于规范化选项；名称、ID 和算法参数按服务端原值输出。
    reset([female, male]);
    const copied = await invoke(["-gender", " \u200Bmale\uFEFF ", "--hair-silky", "--beauty-double-chin"], video);
    assert.strictEqual(copied.code, 0, copied.err);
    assertGenderResult(copied, 0, male, "male", video, true, true);

    // 全部页读取结束后按每个文件的实际媒体选择；同类物料保持服务端顺序。
    const maleImage = { ...male, material_id: 67241, name: "男士图片", media_type_limit: 1 };
    const maleVideo = { ...male, material_id: "67242", name: "男士视频", media_type_limit: 2, material_conf: { parameter: { video_only: true } } };
    const laterMale = { ...male, material_id: 67243, name: "男士通用备用" };
    reset();
    pages = new Map([
      ["", { item_list: [style(), female, maleImage], cursor: nextCursor }],
      [nextCursor, { item_list: [maleVideo, laterMale], cursor: "" }],
    ]);
    const mixedGender = await invoke(["--gender", "male", "--hair-silky"], `${image},${video}`);
    assert.strictEqual(mixedGender.code, 0, mixedGender.err);
    assertGenderResult(mixedGender, 0, maleImage, "male", image, true);
    assertGenderResult(mixedGender, 1, maleVideo, "male", video, true);
    assert.deepStrictEqual(uploads.map(item => item.file), [image, video]);
    assert.deepStrictEqual(events, [listPath, listPath, "/task/ai_type_config", "upload", "/task/submit", "/task/query", "upload", "/task/submit", "/task/query"]);

    // 业务关键词从完整分页中自动选择，跳过首屏不支持当前媒体的同类候选。
    const keywordCases = [["自然", "female"], ["减龄", "female"], ["裸感", "female"], ["女高", "female"], ["浓颜", "female"], ["欧美", "female"], ["紧致", "female"], ["少年", "male"], ["绅士", "male"], ["硬朗", "male"], ["浪漫", "male"]];
    for (const [index, [name, gender]] of keywordCases.entries()) {
      const file = index % 2 === 0 ? image : video;
      const mediaLimit = file === image ? 1 : 2;
      const candidate = style({ material_id: 67300 + index, name, media_type_limit: mediaLimit });
      const opposite = style({ material_id: 67400 + index, name: gender === "female" ? "硬朗" : "裸感" });
      reset();
      pages = new Map([
        ["", { item_list: [style({ name: "柔和" }), opposite, { ...candidate, material_id: 67500 + index, media_type_limit: 3 - mediaLimit }], cursor: nextCursor }],
        [nextCursor, { item_list: [candidate, { ...candidate, material_id: 67600 + index }], cursor: "" }],
      ]);
      const selectedKeyword = await invoke(["--gender", gender], file);
      assert.strictEqual(selectedKeyword.code, 0, selectedKeyword.err);
      assertGenderResult(selectedKeyword, 0, candidate, gender, file);
      assert.deepStrictEqual(events, [listPath, listPath, "/task/ai_type_config", "upload", "/task/submit", "/task/query"]);
    }

    // 明确男女性别覆盖相反风格关键词；混合男女或跨两类关键词仍在上传前拒绝。
    for (const [name, gender] of [["男士自然", "male"], ["女士硬朗", "female"], ["male 减龄", "male"], ["female 少年", "female"]]) {
      const candidate = style({ material_id: 67700, name });
      reset([candidate]);
      const explicitGender = await invoke(["--gender", gender], image);
      assert.strictEqual(explicitGender.code, 0, explicitGender.err);
      assertGenderResult(explicitGender, 0, candidate, gender, image);
    }
    for (const gender of ["male", "female"]) {
      reset(["柔和", "少年自然", "绅士裸感", "硬朗减龄", "男女自然", "male female 硬朗"].map((name, index) => style({ material_id: 67800 + index, name })));
      const ambiguous = await invoke(["--gender", gender], image);
      assert.notStrictEqual(ambiguous.code, 0);
      assert.deepStrictEqual(uploads, []);
      assert.deepStrictEqual(submits, []);
    }

    // 无效同类候选不会遮挡后面的有效候选，也不能作为没有匹配时的兜底。
    const unusable = [
      style({ name: "柔和" }), female, style({ name: "男女通用 male female" }),
      style({ name: "malevolent" }), style({ name: "男士", material_id: "invalid-id" }),
      style({ name: "男士", material_conf: { parameter: {} } }),
      style({ name: "male video only", media_type_limit: 2 }),
    ];
    reset([...unusable, male, laterMale]);
    const filtered = await invoke(["--gender", "male"], image);
    assert.strictEqual(filtered.code, 0, filtered.err);
    assertGenderResult(filtered, 0, male, "male", image);
    for (const [items, gender, input] of [[unusable, "male", image], [[male], "female", video], [[], "male", image]]) {
      reset(items);
      const unmatched = await invoke(["--gender", gender, "--hair-silky"], input);
      assert.notStrictEqual(unmatched.code, 0);
      assert.match(unmatched.err, /风格|gender/);
      assert.deepStrictEqual(uploads, [], "missing gender match cannot silently run only the added effect");
      assert.deepStrictEqual(submits, []);
      assert.ok(events.every(event => [listPath, "/task/ai_type_config"].includes(event)));
    }

    reset([maleImage]);
    const partialGender = await invoke(["--gender", "male"], `${image},${video}`);
    assert.strictEqual(partialGender.code, 2, partialGender.err);
    assertGenderResult(partialGender, 0, maleImage, "male", image);
    assert.strictEqual(JSON.parse(partialGender.out).results[1].ok, false);
    assert.deepStrictEqual(uploads.map(item => item.file), [image]);
    assert.strictEqual(submits.length, 1);

    for (const flags of [
      ["-gender"], ["--gender"], ["--gender=unknown"], ["-gender=MALE"], ["--gender", " \u200B "],
      ["--gender", "male", "--style", "67201"], ["-gender=female", "--list-styles"],
    ]) {
      reset([male, female]);
      const invalidGender = await invoke(flags, image);
      assert.notStrictEqual(invalidGender.code, 0);
      assert.deepStrictEqual(events, []);
      assert.deepStrictEqual(clientUrls, []);
    }
    console.log("ai_beauty: local HTTP style discovery, pagination/auth, media/options matrix, exact task parameters, rights and pre-upload rejection passed");
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
