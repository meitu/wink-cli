"use strict";
const fs = require("fs");
const path = require("path");
const { WinkError } = require("./wink_client");
const { prepareBeautyOptions } = require("./ai_beauty");
// CF 715632845 v5 (2026-09-10). func_type 是限免标识，不是 right_detail.function_id。
const PICTURE_QUALITY_LEVELS = [
  { level: 1, name: "高清", image: "2", video: "1", funcType: "2" },
  { level: 2, name: "超清", image: "12", video: "11", funcType: "9" },
  { level: 3, name: "人像增强", image: "24", video: "13", funcType: "10" },
  { level: 4, name: "AI超清", image: "55", video: "54", imageFuncType: "32", videoFuncType: "35" },
  { level: 5, name: "商品图", image: "72", funcType: "38" },
  { level: 6, name: "文字图表", image: "73", funcType: "37" },
  // 保留已发布档位，避免已有命令失效。
  { level: 7, name: "游戏", image: "91", video: "90" },
  { level: 8, name: "动漫", image: "111", video: "112" },
  { level: 9, name: "高糊图", image: "125" },
  { level: 10, name: "演唱会", image: "128", video: "129" },
  { level: 11, name: "专业级修复", image: "177", video: "176", imageFuncType: "126", videoFuncType: "125" },
  { level: 12, name: "AIGC精修", image: "183", video: "182" },
];
const REMOVE_WATERMARK_LEVELS = [
  { level: 1, name: "自动去印", image: "8", video: "3", funcType: "5", functionId: "63390" },
  { level: 2, name: "AI去水印", image: "95", video: "94", funcType: "51", functionId: "63390" },
];
const single = (name, image, video, extra = {}) => ({ name, defaultLevel: 1, levels: [{ level: 1, name, image, video }], ...extra });
const COMMANDS = Object.freeze({
  picture_quality: { name: "画质修复", defaultLevel: 2, levels: PICTURE_QUALITY_LEVELS },
  // 官网视频全能修复只有 Pro；算法 type 由功能标识匹配运行时配置后确定。
  video_repair: { name: "视频全能修复", defaultLevel: 1, levels: [{ level: 1, name: "Pro", video: "123" }],
    configMatch: { task_type: 2, func_id: 65591 },
    rightDetail: { source: "1", touch_type: "4", function_id: "655", material_id: "65511" },
    options: ["Pro 单档，默认开启抖动检测；处理完整视频，不额外串联补帧、去水印等任务"] },
  resolution_repair: single("分辨率修复", "6", "5", { options: ["--sr-mode <n>                分辨率：0=720p / 1=1080p / 2=2K / 3=4K / 4=8K，默认 1"] }),
  remove_watermark: { name: "消除水印", defaultLevel: 1, levels: REMOVE_WATERMARK_LEVELS },
  denoise: single("降噪", "10", "9", { options: ["--strength <value>           low / median / high，默认 low"] }),
  color_enhance: single("色彩增强", "15", "14"),
  color_unite: single("色调统一", "93", "16", { options: ["--reference <path>           参考图片绝对路径（必填）"], example: '--reference "D:\\reference.jpg"' }),
  cartoon: single("AI动漫", "38", "25", { options: ["--style <id>                 风格类型，例如 xinhaicheng（必填）", "--formula-type <id>          风格效果 ID（必填，取对应风格的 effect_id）", "--max-edge <n>               结果长边：960 / 1080 / 1280 / 1920，默认 960", "图片输入使用预览模式（type=38），视频使用完整处理（type=25）"], example: '--style xinhaicheng --formula-type 1' }),
  night_scene: single("夜景提升", "20", "19", { options: ["--strength <value>           low=中 / median=高，默认 low"] }),
  video_frame: { name: "视频补帧", defaultLevel: 1, levels: [{ level: 1, name: "补帧", video: "4", funcType: "3" }, { level: 2, name: "补帧2.0", video: "36", funcType: "3" }, { level: 3, name: "AIGC补帧", video: "74" }], options: ["--fps <n>                    目标帧率（与 --factor 二选一，均不填由服务端决定）", "--factor <n>                 补帧倍率（大于 1）"] },
  ai_translation: single("AI翻译", undefined, "70", { options: ["--target-language <code>     目标语言（必填，例如 en）", "--source-language <code>     源语言，默认 zh", "--translate-params <json>    完整翻译配置 JSON 或 @文件；可替代语言选项"], example: '--target-language en' }),
  ai_beauty: single("AI美容", "40", "39", { options: [
    "--list-styles               获取当前环境的美颜风格列表，无需 --input",
    "--gender <male|female>      按性别随机选择适用风格，也支持 -gender",
    "                           male：少年/绅士/硬朗/浪漫",
    "                           female：自然/减龄/裸感/女高/浓颜/欧美/紧致",
    "--style <id>                手动指定风格物料 ID，与 --gender 互斥",
    "--hair-silky                开启发质柔顺（默认关闭，可单独使用）",
    "--beauty-double-chin        开启去双下巴（默认关闭，可单独使用）",
    "--gender 与 --style 二选一，或单独开启附加效果；图片/视频参数自动区分",
  ], example: '--hair-silky --beauty-double-chin' }),
  video_defogging: single("视频去雾", undefined, "107"),
  old_photo: single("老照片修复", "122", undefined, { variants: { standard: "122", quality: "161", shared: "164" }, options: ["--variant <value>            standard / quality / shared，默认 standard", "--workflow-params <json>     修复开关 JSON 或 @文件；默认基础修复、超分开启"] }),
});

function prepareTool(command, flags) {
  const params = {}, submit = {};
  const allowed = new Set(["env", "level", "input", "output", "api-key", "force", "interval", "timeout", "base-url", "relogin", "json"]);
  if (command === "ai_beauty") allowed.add("retouch-params"); // 为旧入口给出明确迁移提示。
  for (const line of COMMANDS[command].options || []) {
    const key = /^--([a-z-]+)/.exec(line)?.[1];
    if (key) allowed.add(key);
  }
  for (const key of Object.keys(flags)) if (!allowed.has(key)) throw new WinkError(`未知选项 --${key}，详见 wink-cli ${command} --help`);
  let configValue, taskType, reference;
  const get = (key, fallback) => {
    if (flags[key] === undefined) return fallback;
    if (typeof flags[key] !== "string" || !flags[key].trim()) throw new WinkError(`--${key} 需要参数值`);
    return flags[key];
  };
  const required = (key) => { const value = get(key); if (!value) throw new WinkError(`请指定 --${key}，详见 wink-cli ${command} --help`); return value; };
  const json = (key) => {
    const value = required(key);
    try {
      const parsed = JSON.parse(value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !Object.keys(parsed).length) throw new Error("需要非空 JSON 对象");
      return parsed;
    } catch (error) { throw new WinkError(`--${key} 无法读取 JSON 对象：${error.message}`); }
  };
  const choice = (key, values, fallback) => { const value = get(key, fallback); if (!values.includes(value)) throw new WinkError(`--${key} 可用值：${values.join(" / ")}`); return value; };
  // 与 website/video-repair/ticket.ts 一致；1 表示开启抖动检测，不是强制防抖效果。
  if (command === "video_repair") params.enable_shake = "1";
  if (command === "resolution_repair") {
    configValue = choice("sr-mode", ["0", "1", "2", "3", "4"], "1"); params.sr_mode = Number(configValue);
  }
  if (["denoise", "night_scene"].includes(command)) {
    configValue = choice("strength", command === "denoise" ? ["low", "median", "high"] : ["low", "median"], "low");
    params.denoise_level = configValue;
    if (command === "night_scene") params.enable_denoise = 1;
  }
  if (command === "color_unite") {
    reference = required("reference");
    if (!path.isAbsolute(reference) || !fs.existsSync(reference) || !fs.statSync(reference).isFile() || !/\.(jpe?g|png|webp)$/i.test(reference)) throw new WinkError("--reference 必须为存在的 JPG、PNG 或 WebP 图片绝对路径");
  }
  if (command === "cartoon") {
    configValue = required("style"); params.formula_style = configValue; params.formula_type = required("formula-type");
    params.max_edge = Number(choice("max-edge", ["960", "1080", "1280", "1920"], "960"));
    submit.formulaStyle = params.formula_style; submit.formulaType = params.formula_type;
  }
  if (command === "video_frame") {
    if (flags.fps !== undefined && flags.factor !== undefined) throw new WinkError("--fps 与 --factor 不能同时使用");
    for (const [key, wire] of [["fps", "targ_fps"], ["factor", "fix_rate"]]) if (flags[key] !== undefined) {
      const value = Number(get(key));
      if (!Number.isFinite(value) || value <= (key === "factor" ? 1 : 0)) throw new WinkError(`--${key} 数值无效`);
      params[wire] = value;
    }
  }
  if (command === "ai_translation") {
    if (flags["translate-params"] !== undefined && (flags["target-language"] !== undefined || flags["source-language"] !== undefined)) throw new WinkError("--translate-params 与语言选项不能同时使用");
    const translation = flags["translate-params"] !== undefined ? json("translate-params") : {
      source_language: get("source-language", "zh"), target_language: required("target-language"), add_subtitle: 1, clone_timbre: 1, timbre_id: 0, open_lip_driver: 1,
    };
    if (![translation.source_language, translation.target_language].every(v => typeof v === "string" && v.trim())) throw new WinkError("翻译配置需要 source_language 和 target_language");
    params.translate_params = JSON.stringify(translation);
  }
  const beauty = command === "ai_beauty" ? prepareBeautyOptions(flags) : undefined;
  if (command === "old_photo") {
    taskType = COMMANDS.old_photo.variants[choice("variant", ["standard", "quality", "shared"], "standard")];
    params.workflow_params = JSON.stringify(flags["workflow-params"] !== undefined ? json("workflow-params") : { basic_repair: 1, super_resolution: 1, scratch_repair: 0, color_repair: 0, picture_correct: 0 });
  }
  return { params, submit, configValue, taskType, reference, ...(beauty ? { beauty } : {}) };
}
module.exports = { COMMANDS, PICTURE_QUALITY_LEVELS, REMOVE_WATERMARK_LEVELS, prepareTool };
