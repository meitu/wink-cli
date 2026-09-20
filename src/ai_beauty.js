"use strict";

const crypto = require("crypto");
const { WinkError } = require("./wink_client");

// 美容开关只接受 CLI 明确支持的布尔值，避免把字符串 false 当成开启。
function readBeautyFlag(flags, key) {
  const value = flags[key];
  if (value === undefined || value === false || value === "false" || value === "0") return false;
  if (value === true || value === "true" || value === "1") return true;
  throw new WinkError(`--${key} 只接受 true / false / 1 / 0`);
}

/** 解析 AI 美容选项，在读取风格列表和上传之前拒绝无效组合。 */
function prepareBeautyOptions(flags) {
  if (flags["retouch-params"] !== undefined) {
    throw new WinkError("--retouch-params 已停用，请先用 --list-styles 查询服务端风格，再用 --style 指定物料 ID");
  }
  const listStyles = readBeautyFlag(flags, "list-styles");
  const hairSilky = readBeautyFlag(flags, "hair-silky");
  const beautyDoubleChin = readBeautyFlag(flags, "beauty-double-chin");
  const styleId = flags.style;
  // 去掉复制命令时混入的空白和零宽字符，实际值仍只允许 male/female。
  const gender = typeof flags.gender === "string" ? flags.gender.replace(/[\u200B-\u200D\uFEFF]/g, "").trim() : flags.gender;
  if (gender !== undefined && !["male", "female"].includes(gender)) {
    throw new WinkError("--gender（或 -gender）只接受 male / female");
  }
  if (listStyles) {
    const conflicting = ["input", "style", "gender", "hair-silky", "beauty-double-chin"].find(key => flags[key] !== undefined);
    if (conflicting) throw new WinkError(`--list-styles 不能与 --${conflicting} 同时使用；查询风格不会提交任务`);
  }
  if (gender !== undefined && styleId !== undefined) throw new WinkError("--gender 与 --style 不能同时使用，请选择自动匹配或指定物料 ID");
  if (styleId !== undefined && (typeof styleId !== "string" || !/^\d+$/.test(styleId))) {
    throw new WinkError("--style 需要非空数字物料 ID，请先用 --list-styles 查询");
  }
  if (!listStyles && gender === undefined && styleId === undefined && !hairSilky && !beautyDoubleChin) {
    throw new WinkError("请通过 --gender 自动匹配风格，或用 --list-styles 查询并通过 --style 选择风格，也可单独开启 --hair-silky / --beauty-double-chin");
  }
  return { listStyles, styleId, hairSilky, beautyDoubleChin, ...(gender !== undefined ? { gender } : {}) };
}

/** 顺序读取服务端所有风格分页；失败立即结束，不重试或发起处理任务。 */
async function fetchBeautyStyles(client, { isTest } = {}) {
  const styles = [];
  const cursors = new Set();
  let cursor = "";
  for (;;) {
    let response;
    try {
      response = await client.aiBeautyList({ count: 50, cursor, isTest });
    } catch (error) {
      if (error instanceof WinkError) throw error;
      throw new WinkError(`AI 美容风格列表请求失败：${error.message}`, { cause: error });
    }
    if (!response || response.code !== 0) {
      const message = response?.message ?? response?.msg ?? "服务端未返回成功结果";
      throw new WinkError(`AI 美容风格列表请求失败（code=${response?.code}）：${message}`);
    }
    if (!Array.isArray(response.data?.item_list)) {
      throw new WinkError("AI 美容风格列表响应无效：data.item_list 必须为数组");
    }
    styles.push(...response.data.item_list);
    const nextCursor = response.data.cursor;
    if (nextCursor === undefined || nextCursor === "") return styles;
    if (typeof nextCursor !== "string") {
      throw new WinkError("AI 美容风格列表响应无效：data.cursor 必须为字符串");
    }
    if (cursors.has(nextCursor)) throw new WinkError("AI 美容风格列表响应无效：分页 cursor 重复");
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
}

// 业务确认的风格偏好；只用于挑选服务端素材，不改写美容配置。
const GENDER_STYLE_NAMES = {
  male: ["少年", "绅士", "硬朗", "浪漫"],
  female: ["自然", "减龄", "裸感", "女高", "浓颜", "欧美", "紧致"],
};

/** 优先使用实际接口的 beauty_style，兼容旧文档的 parameter；不合并或改写配置。 */
function beautyStyleParameters(style) {
  const conf = style?.material_conf;
  return [conf?.beauty_style, conf?.parameter].find(value =>
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}

function requireBeautyStyleParameters(style) {
  const parameters = beautyStyleParameters(style);
  if (!parameters) {
    throw new WinkError(`AI 美容风格 ${style.material_id} 的 material_conf.beauty_style 或 material_conf.parameter 必须至少有一个非空对象`);
  }
  return parameters;
}

/** 名称的明确性别标记优先，其次使用业务确认的风格偏好；含男女两类则不自动选。 */
function namedGender(style) {
  if (typeof style?.name !== "string") return undefined;
  const male = /男|\bmale\b/i.test(style.name);
  const female = /女|\bfemale\b/i.test(style.name);
  if (male && female) return undefined;
  if (male || female) return male ? "male" : "female";
  const maleStyle = GENDER_STYLE_NAMES.male.some(name => style.name.includes(name));
  const femaleStyle = GENDER_STYLE_NAMES.female.some(name => style.name.includes(name));
  if (maleStyle === femaleStyle) return undefined;
  return maleStyle ? "male" : "female";
}

/** 先过滤性别、媒体与可投递配置，再从全部适用候选中等概率随机选择。 */
function genderStyle(styles, gender, contentType) {
  if (!["male", "female"].includes(gender)) throw new WinkError("--gender 只接受 male / female");
  if (![1, 2, "1", "2"].includes(contentType)) throw new WinkError("自动匹配 AI 美容风格需要图片或视频类型");
  const candidates = styles.filter(style => {
    if (namedGender(style) !== gender) return false;
    if (style.media_type_limit !== 0 && style.media_type_limit !== Number(contentType)) return false;
    if (!["number", "string"].includes(typeof style.material_id)) return false;
    return /^\d+$/.test(String(style.material_id)) && Boolean(beautyStyleParameters(style));
  });
  if (!candidates.length) {
    throw new WinkError(`未找到适用于${Number(contentType) === 1 ? "图片" : "视频"}的 ${gender} 美容风格（${GENDER_STYLE_NAMES[gender].join(" / ")}或明确的性别标记），请用 --list-styles 查询后通过 --style 手动选择`);
  }
  return candidates[crypto.randomInt(candidates.length)];
}

/** 仅允许选择本次服务端列表中唯一存在且带有有效美容配置的风格。 */
function selectBeautyStyle(styles, styleId, { gender, contentType } = {}) {
  if (gender !== undefined) {
    if (styleId !== undefined) throw new WinkError("--gender 与 --style 不能同时使用");
    styleId = String(genderStyle(styles, gender, contentType).material_id);
  }
  if (styleId === undefined) return undefined;
  const matches = styles.filter(style => String(style?.material_id) === styleId);
  if (!matches.length) throw new WinkError(`未找到 AI 美容风格 ${styleId}，请用 --list-styles 查询当前可用风格`);
  if (matches.length !== 1) throw new WinkError(`AI 美容风格 ${styleId} 的物料 ID 重复，无法确定提交配置`);
  const style = matches[0];
  requireBeautyStyleParameters(style);
  return style;
}

/** 按实际媒体类型组装算法参数和权益物料，保留服务端美容配置的全部字段和值。 */
function buildBeautySubmission(options, style, contentType) {
  if (![1, 2, "1", "2"].includes(contentType)) throw new WinkError("AI 美容仅支持图片 content_type=1 或视频 content_type=2");
  const mediaMode = Number(contentType) - 1;
  if (style) {
    const mediaLimit = style.media_type_limit;
    if (![0, 1, 2].includes(mediaLimit)) {
      throw new WinkError(`AI 美容风格 ${style.material_id} 的 media_type_limit 无效：${mediaLimit}`);
    }
    if (mediaLimit !== 0 && mediaLimit !== Number(contentType)) {
      throw new WinkError(`AI 美容风格 ${style.material_id} 仅支持${mediaLimit === 1 ? "图片" : "视频"}输入`);
    }
  }
  const retouchParams = {};
  const materialIds = [];
  if (style) {
    retouchParams.beauty_style = requireBeautyStyleParameters(style);
    materialIds.push(String(style.material_id));
  }
  if (options.hairSilky) {
    retouchParams.hair_silky = { media_mode: mediaMode };
    materialIds.push("67206");
  }
  if (options.beautyDoubleChin) {
    retouchParams.beauty_double_chin = { media_mode: mediaMode };
    materialIds.push("67207");
  }
  return {
    params: {
      is_mirror: "0",
      orientation_tag: 1,
      preview: 0,
      retouch_ai_params: JSON.stringify(retouchParams),
    },
    rightDetail: { source: "1", touch_type: "4", function_id: "672", material_id: materialIds.join(",") },
  };
}

/** 展示服务端风格名称、物料 ID 和媒体限制，不添加本地预设风格。 */
function formatBeautyStyles(styles) {
  if (!styles.length) return "当前服务端未返回 AI 美容风格。";
  const mediaNames = { 0: "图片 / 视频", 1: "图片", 2: "视频" };
  return ["物料 ID\t名称\t支持媒体", ...styles.map(style => {
    const media = [0, 1, 2].includes(style.media_type_limit) ? mediaNames[style.media_type_limit] : `未知（${style.media_type_limit}）`;
    return `${style.material_id}\t${style.name}\t${media}`;
  })].join("\n");
}

module.exports = { prepareBeautyOptions, fetchBeautyStyles, selectBeautyStyle, buildBeautySubmission, formatBeautyStyles };
