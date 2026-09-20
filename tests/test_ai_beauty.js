"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { WinkError } = require("../src/wink_client");
const { prepareBeautyOptions, fetchBeautyStyles, selectBeautyStyle, buildBeautySubmission, formatBeautyStyles } = require("../src/ai_beauty");

// 合成服务端响应只用于离线测试，参数包含大小写和嵌套结构以验证原样透传。
const parameter = { media_mode: 0, skinAlpha: 0.73, nested: { keep_case: "unchanged", list: [1, false, null] } };
const style = { material_id: 67299, name: "测试风格", media_type_limit: 0, material_conf: { parameter } };

// 测试中的输入被冻结，确保组装参数不会改写调用方或服务端数据。
function freezeDeep(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
freezeDeep(style);

// 所有失败必须为领域错误，便于 CLI 统一输出可理解的失败原因。
function throwsWink(fn, pattern) {
  assert.throws(fn, error => error instanceof WinkError && pattern.test(error.message));
}

// 控制抽样索引验证每个候选都能被选中，避免概率性测试偶发失败。
function withRandomIndex(index, expectedCount, fn) {
  const original = crypto.randomInt;
  let calls = 0;
  crypto.randomInt = max => {
    assert.strictEqual(max, expectedCount);
    calls++;
    return index;
  };
  try {
    const result = fn();
    assert.strictEqual(calls, 1);
    return result;
  } finally {
    crypto.randomInt = original;
  }
}

// 模拟分页客户端记录每次参数，不含上传和任务投递方法。
function pageClient(pages) {
  const calls = [];
  return {
    calls,
    async aiBeautyList(options) {
      calls.push(options);
      if (calls.length > pages.length) throw new Error("unexpected page request");
      return pages[calls.length - 1];
    },
  };
}

(async () => {
  const defaults = prepareBeautyOptions({ style: "67299" });
  assert.deepStrictEqual(defaults, { listStyles: false, styleId: "67299", hairSilky: false, beautyDoubleChin: false });
  for (const key of ["hair-silky", "beauty-double-chin", "list-styles"]) {
    const outputKey = { "hair-silky": "hairSilky", "beauty-double-chin": "beautyDoubleChin", "list-styles": "listStyles" }[key];
    for (const value of [true, "true", "1"]) {
      const flags = key === "list-styles" ? { [key]: value } : { style: "67299", [key]: value };
      assert.strictEqual(prepareBeautyOptions(flags)[outputKey], true);
    }
    for (const value of [false, "false", "0"]) {
      assert.strictEqual(prepareBeautyOptions({ style: "67299", [key]: value })[outputKey], false);
    }
    for (const value of ["yes", "TRUE", "", " false", 0, 1, 2, null, [], {}]) {
      throwsWink(() => prepareBeautyOptions({ style: "67299", [key]: value }), /只接受/);
    }
  }
  for (const value of [true, false, "", " ", "abc", "12x", "1.5", "-1", "1e3", " 67299", 67299, null]) {
    throwsWink(() => prepareBeautyOptions({ style: value }), /--style.*数字/);
  }
  throwsWink(() => prepareBeautyOptions({}), /--list-styles/);
  throwsWink(() => prepareBeautyOptions({ "hair-silky": "false", "beauty-double-chin": "0" }), /--list-styles/);
  for (const flags of [
    { input: "/tmp/media.jpg" }, { style: "67299" }, { "hair-silky": false }, { "beauty-double-chin": "0" },
  ]) throwsWink(() => prepareBeautyOptions({ "list-styles": true, ...flags }), /不能与/);
  for (const value of [true, "{}", "@old.json", false, ""]) {
    throwsWink(() => prepareBeautyOptions({ "retouch-params": value }), /已停用.*--list-styles.*--style/);
    throwsWink(() => prepareBeautyOptions({ "list-styles": true, "retouch-params": value }), /已停用/);
  }

  assert.strictEqual(selectBeautyStyle([style], undefined), undefined);
  assert.strictEqual(selectBeautyStyle([style], "67299"), style);
  assert.strictEqual(selectBeautyStyle([{ ...style, material_id: "67299" }], "67299").material_id, "67299");
  throwsWink(() => selectBeautyStyle([style], "67298"), /未找到.*--list-styles/);
  throwsWink(() => selectBeautyStyle([style, { ...style, material_id: "67299" }], "67299"), /重复/);
  for (const invalid of [undefined, null, {}, [], [1], "{}", 1, true]) {
    const invalidStyle = { ...style, material_conf: { parameter: invalid, beauty_style: { wrong: true } } };
    throwsWink(() => selectBeautyStyle([invalidStyle], "67299"), /parameter.*非空对象/);
  }
  throwsWink(() => selectBeautyStyle([{ ...style, material_conf: undefined }], "67299"), /parameter/);

  // gender 只接受明确值，清理复制文本的边缘空白和零宽字符，不改变旧模式的结果结构。
  for (const gender of ["male", "female"]) {
    for (const value of [gender, ` \t${gender}\n `, `\u200B \uFEFF${gender}\u200D\u200C `]) {
      assert.deepStrictEqual(prepareBeautyOptions({ gender: value }), {
        listStyles: false, styleId: undefined, hairSilky: false, beautyDoubleChin: false, gender,
      });
    }
    const combined = prepareBeautyOptions({ gender, "hair-silky": true, "beauty-double-chin": true });
    assert.strictEqual(combined.gender, gender);
    assert.strictEqual(combined.hairSilky, true);
    assert.strictEqual(combined.beautyDoubleChin, true);
    throwsWink(() => prepareBeautyOptions({ gender, style: "67299" }), /gender|style/);
    throwsWink(() => prepareBeautyOptions({ gender, "list-styles": true }), /gender|list-styles/);
  }
  for (const gender of [true, false, null, "", " \u200B ", "MALE", "Female", "男", "女", "unknown", "male female", 1, {}, []]) {
    throwsWink(() => prepareBeautyOptions({ gender }), /gender/);
  }

  // 明确性别优先于已约定的风格关键词；没有明确性别时按业务关键词匹配。
  const genderStyle = (name, overrides = {}) => ({ ...style, name, ...overrides });
  for (const [gender, names] of [
    ["male", ["男士风格", "男生自然", "male portrait", "Male-style", "少年", "绅士风格", "硬朗效果", "浪漫", "男士自然", "male 减龄裸感"]],
    ["female", ["女士风格", "女生自然", "female portrait", "Female-style", "自然", "减龄风格", "裸感效果", "女高", "浓颜", "欧美", "紧致", "女士硬朗", "female 少年绅士"]],
  ]) {
    for (const name of names) {
      const candidate = freezeDeep(genderStyle(name));
      for (const contentType of [1, 2, "1", "2"]) {
        assert.strictEqual(selectBeautyStyle([candidate], undefined, { gender, contentType }), candidate);
      }
      throwsWink(() => selectBeautyStyle([candidate], undefined, { gender: gender === "male" ? "female" : "male", contentType: 1 }), /风格|gender/);
    }
    for (const name of ["柔和", "清透", "少年自然", "绅士裸感", "硬朗减龄", "男女通用", "male female", "男士 female", "女士 male", "男女自然", "male female 硬朗", "malevolent", "prefemale", "femaleish"]) {
      throwsWink(() => selectBeautyStyle([genderStyle(name)], undefined, { gender, contentType: 1 }), /风格|gender/);
    }
    throwsWink(() => selectBeautyStyle([], undefined, { gender, contentType: 1 }), /风格|gender/);
  }
  throwsWink(() => selectBeautyStyle([genderStyle("female")], undefined, { gender: "male", contentType: 1 }), /风格|gender/);
  throwsWink(() => selectBeautyStyle([genderStyle("male")], undefined, { gender: "female", contentType: 1 }), /风格|gender/);

  // 先过滤媒体与无效物料，全部适用候选都有机会选中；字符串物料 ID 保持原类型。
  const firstMale = freezeDeep(genderStyle("male first", { material_id: "67291", media_type_limit: 1 }));
  const secondMale = freezeDeep(genderStyle("male second", { material_id: 67292, media_type_limit: 0 }));
  const maleVideo = freezeDeep(genderStyle("male video", { material_id: 67293, media_type_limit: 2 }));
  for (const candidates of [[firstMale, secondMale], [secondMale, firstMale]]) {
    for (const index of [0, 1]) {
      assert.strictEqual(withRandomIndex(index, 2, () => selectBeautyStyle(candidates, undefined,
        { gender: "male", contentType: 1 })), candidates[index]);
    }
  }
  assert.strictEqual(selectBeautyStyle([firstMale, maleVideo], undefined, { gender: "male", contentType: 2 }), maleVideo);
  const invalidCandidates = [
    ...[undefined, null, "", "bad", "1.5", -1, 1.5, [67294], {}].map(material_id => genderStyle("male", { material_id })),
    ...[undefined, null, {}, [], "{}"].map(parameter => genderStyle("male", { material_conf: { parameter } })),
    ...[undefined, null, -1, 3, "0", "1", "2"].map(media_type_limit => genderStyle("male", { media_type_limit })),
    genderStyle("female"), genderStyle("male female"), genderStyle("柔和风格"),
  ];
  assert.strictEqual(withRandomIndex(1, 2, () => selectBeautyStyle([...invalidCandidates, firstMale, secondMale], undefined,
    { gender: "male", contentType: 1 })), secondMale);
  const femaleCandidates = ["自然", "减龄", "裸感"].map((name, index) => freezeDeep(genderStyle(name, { material_id: 67400 + index })));
  for (const index of [0, 1, 2]) {
    assert.strictEqual(withRandomIndex(index, 3, () => selectBeautyStyle([maleVideo, ...femaleCandidates], undefined,
      { gender: "female", contentType: 2 })), femaleCandidates[index]);
  }
  throwsWink(() => selectBeautyStyle(invalidCandidates, undefined, { gender: "male", contentType: 1 }), /风格|gender/);
  throwsWink(() => selectBeautyStyle([firstMale], undefined, { gender: "male", contentType: 2 }), /风格|gender/);

  // 风格的四种附加开关组合分别覆盖图片和视频，并核对完整权益物料串。
  for (const contentType of [1, 2]) {
    for (const hairSilky of [false, true]) for (const beautyDoubleChin of [false, true]) {
      const options = freezeDeep({ ...defaults, hairSilky, beautyDoubleChin });
      const result = buildBeautySubmission(options, style, contentType);
      const expectedParams = { beauty_style: parameter };
      const expectedIds = ["67299"];
      if (hairSilky) { expectedParams.hair_silky = { media_mode: contentType - 1 }; expectedIds.push("67206"); }
      if (beautyDoubleChin) { expectedParams.beauty_double_chin = { media_mode: contentType - 1 }; expectedIds.push("67207"); }
      assert.strictEqual(typeof result.params.retouch_ai_params, "string");
      assert.deepStrictEqual(JSON.parse(result.params.retouch_ai_params), expectedParams);
      assert.deepStrictEqual(result.params, {
        is_mirror: "0", orientation_tag: 1, preview: 0, retouch_ai_params: JSON.stringify(expectedParams),
      });
      assert.deepStrictEqual(result.rightDetail, { source: "1", touch_type: "4", function_id: "672", material_id: expectedIds.join(",") });
      assert.deepStrictEqual(buildBeautySubmission(options, style, String(contentType)), result);
    }
    for (const switches of [
      { "hair-silky": true }, { "beauty-double-chin": true }, { "hair-silky": true, "beauty-double-chin": true },
    ]) {
      const options = prepareBeautyOptions(switches);
      const result = buildBeautySubmission(options, undefined, contentType);
      const actual = JSON.parse(result.params.retouch_ai_params);
      const expected = {};
      if (options.hairSilky) expected.hair_silky = { media_mode: contentType - 1 };
      if (options.beautyDoubleChin) expected.beauty_double_chin = { media_mode: contentType - 1 };
      assert.deepStrictEqual(actual, expected);
      assert.strictEqual(result.rightDetail.material_id, [options.hairSilky && "67206", options.beautyDoubleChin && "67207"].filter(Boolean).join(","));
    }
    assert.ok(buildBeautySubmission(defaults, { ...style, media_type_limit: contentType }, contentType));
    throwsWink(() => buildBeautySubmission(defaults, { ...style, media_type_limit: 3 - contentType }, contentType), /仅支持/);
    for (const mediaLimit of [undefined, null, -1, 3, "0", "1", "2"]) {
      throwsWink(() => buildBeautySubmission(defaults, { ...style, media_type_limit: mediaLimit }, contentType), /media_type_limit/);
    }
  }
  for (const contentType of [0, 3, undefined, null, "image", "video"]) {
    throwsWink(() => buildBeautySubmission(defaults, style, contentType), /content_type/);
  }
  assert.deepStrictEqual(parameter, { media_mode: 0, skinAlpha: 0.73, nested: { keep_case: "unchanged", list: [1, false, null] } });

  const paged = pageClient([
    { code: 0, data: { item_list: [style], cursor: "next" } },
    { code: 0, data: { item_list: [], cursor: "last" } },
    { code: 0, data: { item_list: [{ ...style, material_id: 67300 }], cursor: "" } },
  ]);
  assert.deepStrictEqual(await fetchBeautyStyles(paged, { isTest: 1 }), [style, { ...style, material_id: 67300 }]);
  assert.deepStrictEqual(paged.calls, [
    { count: 50, cursor: "", isTest: 1 }, { count: 50, cursor: "next", isTest: 1 }, { count: 50, cursor: "last", isTest: 1 },
  ]);
  const noCursor = pageClient([{ code: 0, data: { item_list: [] } }]);
  assert.deepStrictEqual(await fetchBeautyStyles(noCursor), []);
  assert.deepStrictEqual(noCursor.calls, [{ count: 50, cursor: "", isTest: undefined }]);
  // HTTP 成功但业务失败时，保留 message 原文；旧响应只含 msg 时仍可显示原因。
  for (const [response, expectedMessage] of [
    [{ code: 12, message: "风格暂不可用\n请稍后重试（request_id=test-123）", msg: "旧字段" }, "风格暂不可用\n请稍后重试（request_id=test-123）"],
    [{ code: 12, message: "", msg: "旧字段" }, ""],
    [{ code: 12, msg: "旧协议失败原因" }, "旧协议失败原因"],
  ]) {
    const failed = pageClient([response]);
    await assert.rejects(() => fetchBeautyStyles(failed), error => error instanceof WinkError
      && error.message === `AI 美容风格列表请求失败（code=12）：${expectedMessage}`);
    assert.strictEqual(failed.calls.length, 1, "business failures must not trigger a retry");
  }
  for (const response of [
    undefined, null, { code: "0", data: { item_list: [] } }, { code: 12, msg: "upstream failure" },
    { code: 0 }, { code: 0, data: {} }, { code: 0, data: { item_list: {} } },
    { code: 0, data: { item_list: [], cursor: null } }, { code: 0, data: { item_list: [], cursor: 0 } },
  ]) {
    const invalid = pageClient([response]);
    await assert.rejects(() => fetchBeautyStyles(invalid), WinkError);
    assert.strictEqual(invalid.calls.length, 1, "invalid responses must not trigger a retry");
  }
  const repeated = pageClient([
    { code: 0, data: { item_list: [style], cursor: "next" } },
    { code: 0, data: { item_list: [], cursor: "next" } },
  ]);
  await assert.rejects(() => fetchBeautyStyles(repeated), /cursor 重复/);
  assert.strictEqual(repeated.calls.length, 2);
  const cycle = pageClient([
    { code: 0, data: { item_list: [], cursor: "one" } },
    { code: 0, data: { item_list: [], cursor: "two" } },
    { code: 0, data: { item_list: [], cursor: "one" } },
  ]);
  await assert.rejects(() => fetchBeautyStyles(cycle), /cursor 重复/);
  assert.strictEqual(cycle.calls.length, 3);
  let failures = 0;
  const networkError = new Error("offline");
  await assert.rejects(() => fetchBeautyStyles({ async aiBeautyList() { failures++; throw networkError; } }),
    error => error instanceof WinkError && /风格列表请求失败.*offline/.test(error.message) && error.cause === networkError);
  assert.strictEqual(failures, 1);
  const authError = new WinkError("GET /material/ai_beauty/list：HTTP 401");
  authError.httpStatus = 401;
  await assert.rejects(() => fetchBeautyStyles({ async aiBeautyList() { throw authError; } }), error => error === authError);

  const formatted = formatBeautyStyles([
    style, { ...style, material_id: 67300, name: "图片风格", media_type_limit: 1 },
    { ...style, material_id: 67301, name: "视频风格", media_type_limit: 2 },
  ]);
  assert.strictEqual(formatted, "物料 ID\t名称\t支持媒体\n67299\t测试风格\t图片 / 视频\n67300\t图片风格\t图片\n67301\t视频风格\t视频");
  assert.match(formatBeautyStyles([]), /未返回/);
  assert.match(formatBeautyStyles([{ ...style, media_type_limit: 9 }]), /未知（9）/);
  console.log("AI beauty: strict flags, original style parameters, media limits, switch combinations, paginated listing and errors passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
