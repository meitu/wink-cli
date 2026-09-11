"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { UploadClient, UploadError, request } = require("./upload_sdk");

const DEFAULT_BASE_URL = "https://precliapi-winkcut.meitu.com";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB
const MAX_DOWNLOAD_REDIRECTS = 5;
const SERVER_VERSION = require("../package.json").version;

// /task/submit (客户端投递协议) 的字段默认值 —— 均可被 options 或 WINK_TASK_* 环境变量覆盖。
// 见 mock 定义：https://api-mock.meitu-int.com/project/2309/interface/api/249765
// 客户端 client_id 登录与投递统一为一份:登录(/init/auth、/init/exchange)时服务端
// 用该 id 登记,后续 /task/submit、/task/query、/file/get_maat_sign 的通用传参块才被
// 视为已初始化(否则报「请求通用参数未初始化」)。取值优先级统一:显式 clientId 参数
// > env WINK_CLIENT_ID > 本默认值;只需在 CLI 环境变量中一处(WINK_CLIENT_ID)配置,
// 登录与投递同时生效,无需再区分两套。
const DEFAULT_CLIENT_ID = "1189857724";

/** client_id 统一解析:显式参数 > WINK_CLIENT_ID env > DEFAULT_CLIENT_ID。 */
function resolveClientId(explicit) {
  return explicit || process.env.WINK_CLIENT_ID || DEFAULT_CLIENT_ID;
}
const DEFAULT_TASK_TYPE = "11"; // 视频画质修复（图片画质修复为 12）；资源类型无法识别时的兜底，见 confluence pageId=262381582
const DEFAULT_RIGHT_DETAIL = JSON.stringify({ source: "1", touch_type: "4", function_id: "630", material_id: "63001" }); // 消费来源（画质修复示例）
const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "flv", "wmv", "3gp", "mpeg", "mpg", "ts"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff", "avif"]);

// Pre-generated once_code (32 chars, lowercase letters + digits). Wink /init/auth
// accepts it as an optional query param and binds it to the login, so an AI can
// pre-generate one, send the user to /init/auth?once_code=..., then poll
// /init/exchange itself — the api_key never has to be copied by the human.
const ONCE_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function generateOnceCode(length = 32) {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) code += ONCE_CODE_ALPHABET[bytes[i] % ONCE_CODE_ALPHABET.length];
  return code;
}

class WinkError extends Error {}

const { isInsufficientBeans } = require("./beans");

function responseOk(payload) {
  return Boolean(payload && typeof payload === "object" && payload.code === 0);
}

function dataObject(payload) {
  return payload && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data : {};
}

async function winkRequest(method, endpoint, query, options) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = new URL(baseUrl + endpoint);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const apiKey = options.apiKey || "";
  if (options.requireKey && !apiKey) throw new WinkError("no Wink API key configured (set WINK_CLI_API_KEY or pass apiKey)");
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (apiKey) headers.api_key = apiKey;
  let response;
  try {
    response = await request(method, url.toString(), {
      headers,
      body: method === "POST" ? (options.body != null ? options.body : Buffer.alloc(0)) : null,
      timeout: (options.requestTimeout || 30) * 1000,
    });
  } catch (error) {
    const details = [];
    if (error.httpStatus) details.push(`HTTP ${error.httpStatus}`);
    if (error.extCode) details.push(`code=${error.extCode}`);
    const failure = new WinkError(`${method} ${endpoint}：${error.message}${details.length ? `（${details.join("，")}）` : ""}`);
    failure.httpStatus = error.httpStatus;
    failure.extCode = error.extCode;
    failure.endpoint = endpoint;
    throw failure;
  }
  let payload;
  try {
    payload = JSON.parse(response.body.toString("utf8"));
  } catch (_) {
    throw new WinkError("server returned invalid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WinkError("server returned an invalid JSON object");
  }
  return payload;
}

function uploadAccessUrl(payload) {
  const data = payload && payload.data;
  const candidates = [];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    candidates.push(data.accessUrl, data.url);
    if (data.data && typeof data.data === "object") candidates.push(data.data.accessUrl, data.data.url);
    else candidates.push(data.data);
  } else if (typeof data === "string") {
    candidates.push(data);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return candidate;
    } catch (_) {}
  }
  throw new WinkError("upload response does not contain a usable resource URL");
}

function resultUrl(payload) {
  const data = dataObject(payload);
  const candidates = [];
  const push = (value) => { if (typeof value === "string" && value) candidates.push(value); };
  push(data.result_url); // 旧协议
  push(data.url); // 新协议（/task/query）顶层结果媒体
  const result = data.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    push(result.url);
    if (Array.isArray(result.media_info_list)) {
      for (const item of result.media_info_list) {
        if (!item || typeof item !== "object") continue;
        push(item.media_data || item.url);
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return candidate;
    } catch (_) {}
  }
  throw new WinkError("finished Wink response has no valid result media URL (data.url / data.result_url / data.result.media_info_list[].media_data)");
}

/**
 * WinkClient: dependency-free client for the Wink cloud media processing API.
 * Pure library — no argv parsing, no stdout output. Every method returns a plain
 * object. Download and upload progress go to the optional `log` callback only
 * (defaults to stderr), keeping stdout available for CLI output.
 */
class WinkClient {
  /**
   * @param {object} [config]
   * @param {string} [config.baseUrl]     Wink API base URL
   * @param {string} [config.apiKey]      Wink API key (required for task operations)
   * @param {string} [config.accessToken] Upload access token
   * @param {(line: string) => void} [config.log] progress/log sink
   */
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = config.apiKey || "";
    this.accessToken = config.accessToken || "";
    this.log = config.log || ((line) => process.stderr.write(`${line}\n`));
  }

  withApiKey(apiKey) {
    return new WinkClient({ ...this.configOf(), apiKey: apiKey || this.apiKey });
  }

  configOf() {
    return { baseUrl: this.baseUrl, apiKey: this.apiKey, accessToken: this.accessToken, log: this.log };
  }

  request(method, endpoint, query, options = {}) {
    return winkRequest(method, endpoint, query, { baseUrl: this.baseUrl, apiKey: this.apiKey, ...options });
  }

  /**
   * Build the SSO authorization URL the user opens in a browser.
   * The URL carries `client_id` (shared login/task client id, default
   * WINK_CLIENT_ID or DEFAULT_CLIENT_ID) in addition to once_code — the
   * server requires the client id to be registered at login time, otherwise
   * later /task/submit calls answer "请求通用参数未初始化".
   * @param {string} [onceCode] optional pre-generated once_code (32 chars). When
   *   omitted, one is generated here and returned so the caller can poll
   *   /init/exchange afterwards without the human copying anything.
   * @param {string} [clientId] optional client id override; default
   *   WINK_CLIENT_ID env then DEFAULT_CLIENT_ID.
   */
  authUrl(onceCode, clientId) {
    const code = (onceCode && /^[a-z0-9]{16,32}$/.test(onceCode)) ? onceCode : generateOnceCode();
    const url = new URL(`${this.baseUrl}/init/auth`);
    url.searchParams.set("once_code", code);
    url.searchParams.set("client_id", resolveClientId(clientId));
    return { ok: true, auth_url: url.toString(), once_code: code };
  }

  /**
   * Exchange for an API key. Two modes (behaviour verified 2026-09-07 on pre):
   *  - with once_code -> registered-code mode: servers implementing the
   *    documented pre-generated-code flow bind the code to the SSO login and
   *    return a DEDICATED api_key once the human authorizes (fixed and live on
   *    pre as of 2026-09-07; codes never registered still answer 20001).
   *  - no once_code  -> legacy fallback: the server returns the active api_key
   *    of the most recent login (stable/idempotent). Useful for older servers
   *    that drop the code in the SSO redirect, but it may cross accounts when
   *    several users log in concurrently — prefer the coded mode.
   */
  async exchange(onceCode, clientId) {
    const query = { client_id: resolveClientId(clientId) };
    if (onceCode == null || onceCode === "") return this.request("GET", "/init/exchange", query);
    if (typeof onceCode !== "string") throw new WinkError("once_code is required");
    query.once_code = onceCode;
    return this.request("GET", "/init/exchange", query);
  }

  /**
   * Submit a processing task for an existing public resource URL.
   *
   * Wire protocol (adjusted 2026-09: client-facing /task/submit):
   *   POST /task/submit with application/x-www-form-urlencoded body carrying the
   *   client-side field set (client_id/version/gnum/type/source_url/ext_params/
   *   right_detail/content_type/with_prepare …). Task id in the response is
   *   data.msg_id (legacy data.task_id still honoured).
   *
   * @param {string} resourceUrl public HTTP(S) URL of the media to process
   * @param {object} [options] submit-field overrides (see buildSubmitForm) plus
   *   { accessToken } for the Access-Token header
   */
  async submit(resourceUrl, options = {}) {
    if (!resourceUrl || typeof resourceUrl !== "string") throw new WinkError("resource_url is required");
    const form = buildSubmitForm(resourceUrl, options, taskDefaults());
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    const accessToken = options.accessToken || this.accessToken;
    if (accessToken) headers["Access-Token"] = accessToken;
    return this.request("POST", "/task/submit", null, {
      headers,
      body: Buffer.from(form.toString(), "utf8"),
      requireKey: false, // 新协议不带 api_key 也能投递（mock/无鉴权后端）；有 key 仍会附带
    });
  }

  /**
   * Query a Wink task by msg_id（客户端查询协议，2026-09 调整：与 /task/submit 同款
   * 客户端通用传参块 + msg_id，见 mock api-mock.meitu-int.com project/2309 的
   * GET /task/query）。终态由应答 data.result 块推断（见 taskState）；旧后端返回的
   * data.status 字段仍兼容。
   * @param {string} msgId 任务 id（wink_submit 返回的 data.msg_id）
   * @param {object} [options] clientId/version/language/channelId/gnum/countryCode/
   *   isTest 覆盖 + { accessToken }（Access-Token 头）
   */
  async query(msgId, options = {}) {
    const params = buildQueryParams(msgId, options, taskDefaults());
    const headers = {};
    const accessToken = options.accessToken || this.accessToken;
    if (accessToken) headers["Access-Token"] = accessToken;
    return this.request("GET", "/task/query", params, {
      headers,
      requireKey: false, // 与 /task/submit 一致：有 api_key 自动附带、不强制
    });
  }

  /** 获取用户美豆余额；账号 Access-Token（若有）与 api_key 不互相替代。 */
  async remainAmountInfo(options = {}) {
    const headers = {};
    const accessToken = options.accessToken || this.accessToken;
    if (accessToken) headers["Access-Token"] = accessToken;
    return this.request("GET", "/subscribe/remain_amount_info", clientIdentityParams(options, taskDefaults()), {
      headers,
      requestTimeout: options.requestTimeout,
    });
  }

  /**
   * Fetch the AI feature config list（GET /task/ai_type_config，2026-09 接入）。
   * 时机：投递之前调用——取回云处理配置（支持的输入类型 content_type、视频时长
   * 上/下限 min_time/max_time(_normal)、计费 beans/vip_beans、档位 func_id 等），
   * 用于在投递前校验用户输入是否被支持。请求带客户端通用传参块；options.type
   * （AI 功能类型，对应 /task/submit 的 type：11=视频画质修复 12=图片画质修复…）
   * 可选——带上则服务端按类型过滤，不传返回全量列表。
   * @param {object} [options] { type?, clientId/version/language/channelId/gnum/
   *   countryCode/isTest 覆盖 + { accessToken }（Access-Token 头） }
   */
  async aiTypeConfig(options = {}) {
    const params = buildAiTypeConfigParams(options, taskDefaults());
    const headers = {};
    const accessToken = options.accessToken || this.accessToken;
    if (accessToken) headers["Access-Token"] = accessToken;
    return this.request("GET", "/task/ai_type_config", params, {
      headers,
      requireKey: false, // 与 /task/query 一致：有 api_key 自动附带、不强制
    });
  }

  /**
   * Submit and poll until the task finishes or fails.
   * @returns the final task payload
   */
  async run(resourceUrl, options = {}) {
    if (!resourceUrl || typeof resourceUrl !== "string") throw new WinkError("resource_url is required");
    const interval = positiveNumber(options.interval, 3);
    const timeout = positiveNumber(options.timeout, 600);
    let submitted;
    while (true) {
      try {
        submitted = await this.submit(resourceUrl, options);
      } catch (error) {
        // Retry only an explicit rejection by submit, never an ambiguous network failure.
        if (isInsufficientBeans(error) && options.onInsufficientBeans && await options.onInsufficientBeans(error)) continue;
        throw error;
      }
      if (isInsufficientBeans(submitted) && options.onInsufficientBeans && await options.onInsufficientBeans(submitted)) continue;
      break;
    }
    if (!responseOk(submitted)) return submitted;
    const data = dataObject(submitted);
    const taskId = data.task_id || data.msg_id;
    if (typeof taskId !== "string" || !taskId) throw new WinkError("submit response has no data.task_id / data.msg_id");
    const deadline = Date.now() + timeout * 1000;
    while (true) {
      const queried = await this.query(taskId, options);
      if (!responseOk(queried)) return queried;
      const taskData = dataObject(queried);
      const state = taskState(taskData);
      const extra = [];
      if (state.status) extra.push(`status=${state.status}`);
      if (taskData.remaining_elapsed != null) extra.push(`remaining=${taskData.remaining_elapsed}`);
      if (state.msg) extra.push(`msg=${state.msg}`);
      if (options.onProgress) {
        options.onProgress({ phase: state.phase, taskId, remainingMs: taskData.remaining_elapsed });
      } else {
        this.log(`task_id=${taskId} phase=${state.phase}${extra.length ? ` ${extra.join(" ")}` : ""}`);
      }
      if (state.phase === "finish" || state.phase === "fail") return queried;
      if (Date.now() >= deadline) throw new WinkError(`task ${taskId} did not finish within ${timeout} seconds`);
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  }

  /**
   * Upload a local file and return the public resource URL.
   * @returns {{ ok: true, file: string, resource_url: string, upload: object }}
   */
  async uploadFile(file, options = {}) {
    if (!file || typeof file !== "string") throw new WinkError("file path is required");
    const inputFile = path.resolve(file);
    const stat = await fs.promises.stat(inputFile).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) {
      throw new WinkError(`input file is missing or empty: ${inputFile}`);
    }
    const strategyHosts = options.strategyHosts && options.strategyHosts.length
      ? options.strategyHosts
      : process.env.MTCPPUPLOAD_STRATEGY_HOST
        ? [process.env.MTCPPUPLOAD_STRATEGY_HOST]
        : [];
    const uploader = new UploadClient({
      appKey: options.appKey || "wink",
      accessToken: this.accessToken || "",
      resourceType: options.resourceType || "media",
      suffix: options.suffix != null ? options.suffix : path.extname(inputFile).slice(1),
      test: Boolean(options.test),
      strategyHosts,
    }, {
      progress: (value) => options.onProgress ? options.onProgress(value) : this.log(`upload progress=${value.toFixed(4)}`),
    });
    const upload = await uploader.uploadFile(inputFile);
    const resourceUrl = uploadAccessUrl(upload);
    // 媒体类型在上传时就按文件扩展名定死（1-图片 2-视频），投递时直接沿用，
    // 避免投递阶段再按 URL 猜一次造成类型不一致。
    const contentType = inferContentType(resourceUrl);
    return { ok: true, file: inputFile, resource_url: resourceUrl, content_type: contentType, upload };
  }

}

function positiveNumber(value, fallback) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("expected a positive number");
  return parsed;
}

// ---------------------------------------------------------------- submit 协议

/** 取第一个非 null/undefined 的值（空串不算缺失，按显式值发送）。 */
function first(...candidates) {
  for (const value of candidates) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** 根据资源 URL 扩展名推断 content_type（投递资源信息：1-图片 2-视频）；无法判断返回 undefined。 */
function inferContentType(sourceUrl) {
  let ext = "";
  try {
    ext = path.extname(new URL(sourceUrl).pathname).toLowerCase().replace(/^\./, "");
  } catch (_) { /* keep empty */ }
  if (VIDEO_EXTS.has(ext)) return "2";
  if (IMAGE_EXTS.has(ext)) return "1";
  return undefined;
}

/**
 * 由资源类型（content_type：1-图片 2-视频）联动推断画质修复任务 type：
 * 图片→12、视频→11；无法判断返回 undefined（由 DEFAULT_TASK_TYPE 兜底）。
 * 口径来源：confluence pageId=262381582（视频画质修复 type=11，图片 type=12）。
 */
function inferTaskType(contentType) {
  if (String(contentType) === "1") return "12";
  if (String(contentType) === "2") return "11";
  return undefined;
}

/**
 * gnum：显式 options/env > 首次生成的稳定本地设备标识。
 * 沿用 ~/.wink-mcp-server/task-gnum 路径以兼容已有 CLI 安装。任何一步失败都
 * 静默降级到下一步，全部不可用时返回空串（字段随之省略）。
 */
function resolveGnumSync() {
  if (process.env.WINK_TASK_GNUM) return process.env.WINK_TASK_GNUM;
  try {
    const dir = path.join(os.homedir(), ".wink-mcp-server");
    const file = path.join(dir, "task-gnum");
    if (fs.existsSync(file)) {
      const cached = fs.readFileSync(file, "utf8").trim();
      if (cached) return cached;
    }
    const fresh = crypto.randomBytes(16).toString("hex").toUpperCase();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, fresh, { mode: 0o600 });
    return fresh;
  } catch (_) {
    return "";
  }
}

/** submit/query 的非调用方显式默认值（gnum/version 走运行期解析，便于 env/缓存）。 */
function taskDefaults() {
  return { gnum: resolveGnumSync(), version: SERVER_VERSION };
}

/**
 * 客户端通用传参块：/task/submit 与 /task/query 共用的头部字段
 * （client_id/version/client_language/client_channel_id/gnum/country_code/is_test）。
 * 取值优先级：显式 options > 环境变量（client_id 走 WINK_CLIENT_ID，其余 WINK_TASK_*）
 * > defaults > 文档默认值；
 * 值为空（null/undefined/空串）的字段省略。返回普通对象。
 */
function clientIdentityParams(options = {}, defaults = {}, envVar = (name) => process.env[name]) {
  const o = options || {};
  const d = defaults || {};
  const params = {};
  const put = (key, value) => {
    if (value !== undefined && value !== null && String(value) !== "") params[key] = String(value);
  };
  put("client_id", first(o.clientId, envVar("WINK_CLIENT_ID"), d.clientId, DEFAULT_CLIENT_ID));
  put("version", first(o.version, envVar("WINK_TASK_VERSION"), d.version, SERVER_VERSION));
  put("client_language", first(o.clientLanguage, envVar("WINK_TASK_LANGUAGE"), d.clientLanguage, "zh-Hans"));
  // 沿用服务端已使用的渠道值，纯 CLI 清理不改变投递协议。
  put("client_channel_id", first(o.channelId, envVar("WINK_TASK_CHANNEL_ID"), d.channelId, "mcp"));
  put("gnum", first(o.gnum, envVar("WINK_TASK_GNUM"), d.gnum));
  put("country_code", first(o.countryCode, envVar("WINK_TASK_COUNTRY_CODE"), d.countryCode));
  put("is_test", first(o.isTest, envVar("WINK_TASK_IS_TEST"), d.isTest));
  return params;
}

/**
 * 组装 /task/submit 的 form 字段（application/x-www-form-urlencoded）。
 * options 键为驼峰（clientId/version/language/channelId/gnum/countryCode/
 * isTest/taskType/height/width/duration/size/coverPic/extParams/typeParams/
 * ticket/rightDetail/groupTaskId/cutRange/contentType/withPrepare/accessToken）。
 * 取值优先级：显式 options > WINK_TASK_* 环境变量 > defaults > 文档默认值；
 * 仍为 undefined 的字段直接省略。
 * @returns {URLSearchParams}
 */
function buildSubmitForm(sourceUrl, options = {}, defaults = {}) {
  const o = options || {};
  const d = defaults || {};
  const envVar = (name) => process.env[name];
  const params = new URLSearchParams();
  const put = (key, value) => {
    if (value !== undefined && value !== null && String(value) !== "") params.set(key, String(value));
  };
  // 客户端通用传参块（/task/query 共用）：client_id/version/client_language/
  // client_channel_id/gnum/country_code/is_test
  for (const [key, value] of Object.entries(clientIdentityParams(o, d, envVar))) put(key, value);
  // 资源类型：显式 > env > defaults > 按 URL 扩展名推断（1-图片 2-视频）
  const resolvedContentType = first(o.contentType, envVar("WINK_TASK_CONTENT_TYPE"), d.contentType, inferContentType(sourceUrl));
  // 任务类型（画质修复）：显式 > env > defaults > 按资源类型联动（图片 1→12，视频 2→11）> 兜底 11
  put("type", first(o.taskType, envVar("WINK_TASK_TYPE"), d.taskType, inferTaskType(resolvedContentType), DEFAULT_TASK_TYPE));
  put("height", first(o.height, envVar("WINK_TASK_HEIGHT"), d.height));
  put("width", first(o.width, envVar("WINK_TASK_WIDTH"), d.width));
  put("duration", first(o.duration, envVar("WINK_TASK_DURATION"), d.duration));
  put("size", first(o.size, envVar("WINK_TASK_SIZE"), d.size));
  put("source_url", sourceUrl);
  put("cover_pic", first(o.coverPic, d.coverPic));
  put("formula_style", first(o.formulaStyle, d.formulaStyle));
  put("formula_type", first(o.formulaType, d.formulaType));
  // 参数/来源
  put("ext_params", first(o.extParams, envVar("WINK_TASK_EXT_PARAMS"), d.extParams, "{}"));
  put("type_params", first(o.typeParams, envVar("WINK_TASK_TYPE_PARAMS"), d.typeParams, "{}"));
  put("ticket", first(o.ticket, d.ticket));
  put("right_detail", first(o.rightDetail, envVar("WINK_TASK_RIGHT_DETAIL"), d.rightDetail, DEFAULT_RIGHT_DETAIL));
  put("group_task_id", first(o.groupTaskId, d.groupTaskId));
  put("cut_range", first(o.cutRange, d.cutRange));
  // 资源类型与预处理
  put("content_type", resolvedContentType);
  put("with_prepare", first(o.withPrepare, envVar("WINK_TASK_WITH_PREPARE"), d.withPrepare, 0));
  return params;
}

/**
 * 组装 GET /task/query 的查询参数（普通对象，由 request 统一做 URL 编码）。
 * 与 /task/submit 共用客户端通用传参块，另加 msg_id；options 键为驼峰
 * （clientId/version/language/channelId/gnum/countryCode/isTest）。
 * @returns {{ msg_id: string, [key: string]: string }}
 */
function buildQueryParams(msgId, options = {}, defaults = {}) {
  if (!msgId || typeof msgId !== "string") throw new WinkError("msg_id is required");
  const params = clientIdentityParams(options, defaults);
  params.msg_id = msgId;
  return params;
}

/**
 * 组装 GET /task/ai_type_config 的查询参数（普通对象，由 request 统一做 URL 编码）。
 * 与 /task/query 共用客户端通用传参块；options.type（AI 功能类型，对应投递接口
 * 的 type，如 11=视频画质修复 12=图片画质修复）可选，传了才携带。
 * @returns {{ [key: string]: string }}
 */
function buildAiTypeConfigParams(options = {}, defaults = {}) {
  const params = clientIdentityParams(options, defaults);
  const type = options.type != null ? String(options.type) : "";
  if (type) params.type = type;
  return params;
}

/**
 * 投递前校验：按 AI 功能类型在 ai_type_config 返回列表中找到对应配置，
 * 并检查用户输入是否被支持。
 * 注意值域差异（2026-09-09 pre 实测）：ai_type_config 配置项的 type 是
 * 1=画质修复-高清(视频)、2=画质修复-高清(图片)；而 /task/submit 的 type 是
 * 11/12。input.type 两个值域都收——先按原值匹配，再按 submit→config 映射
 * （12→2、11→1）匹配；未传 type 时按 content_type 匹配。
 * @param {object|Array} payload aiTypeConfig() 的完整应答（取 data 数组）或直接传数组
 * @param {object} input { contentType: "1"|"2"（用户输入的媒体类型，必填）,
 *   type?: string（11/12 投递值域或 1/2 配置值域）, durationSeconds?: number（视频时长，秒）,
 *   isVip?: boolean }
 * @returns {{ ok: boolean, config?: object, reason?: string }}
 *   ok=false 时 reason 为可直接展示给用户的中文提示。
 */
function checkAiTypeSupport(payload, input = {}) {
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.data) ? payload.data : []);
  if (!list.length) return { ok: false, reason: "获取 AI 功能配置列表为空，服务端可能未配置该功能" };
  const contentType = input.contentType != null ? String(input.contentType) : "";
  let config = null;
  if (input.type != null) {
    const matches = list.filter(item => item && String(item.type) === String(input.type));
    config = matches.find(item => (!contentType || String(item.content_type) === contentType) && Number(item.is_local_process || 0) === 0
      && (input.configValue == null || String(item.ext_value) === String(input.configValue))) || null;
    if (!config && matches.length && input.configValue != null) return { ok: false, reason: `当前环境不支持 type=${input.type} 的参数 ${input.configValue}` };
    if (!config && matches.length && !input.strictType) config = matches[0];
    if (!config && !input.strictType) {
      // submit 值域(11=视频/12=图片)到 config 值域(1=视频/2=图片)的映射
      const configType = String(input.type) === "12" ? "2" : String(input.type) === "11" ? "1" : null;
      if (configType) config = list.find((item) => item && String(item.type) === configType) || null;
    }
    if (!config) {
      return { ok: false, reason: `当前环境的 AI 功能配置中不存在 type=${input.type} 对应的云处理能力` };
    }
  } else if (contentType) {
    config = list.find((item) => item && String(item.content_type) === contentType) || null;
    if (!config) return { ok: false, reason: `AI 功能配置中不存在输入类型为 ${contentType === "1" ? "图片" : contentType === "2" ? "视频" : contentType} 的功能，现有：${list.map((c) => c.name).join("、")}` };
  } else {
    return { ok: false, reason: "校验需要 type 或 contentType 之一" };
  }
  // 输入媒体类型必须与配置的输入内容类型一致
  if (contentType && String(config.content_type) !== contentType) {
    const want = config.content_type === 1 ? "图片" : "视频";
    const got = contentType === "1" ? "图片" : "视频";
    return { ok: false, config, reason: `该功能「${config.name}」只支持${want}输入，你传的是${got}` };
  }
  const limits = config.input_limit || {};
  const reject = reason => ({ ok: false, config, reason });
  if (input.extension && Array.isArray(limits.formats) && limits.formats.length && !limits.formats.map(x => String(x).toLowerCase().replace(/^\./, "")).includes(input.extension)) return reject(`该功能不支持 ${input.extension} 格式，可用格式：${limits.formats.join("、")}`);
  if (limits.max_size_bytes > 0 && input.size > limits.max_size_bytes) return reject(`文件大小超过该功能上限 ${limits.max_size_bytes} 字节`);
  if (limits.max_edge > 0 && Math.max(input.width || 0, input.height || 0) > limits.max_edge) return reject(`媒体长边超过该功能上限 ${limits.max_edge} 像素`);
  if (limits.max_pixels > 0 && input.width * input.height > limits.max_pixels) return reject(`媒体像素数超过该功能上限 ${limits.max_pixels}`);
  if (limits.max_duration_ms > 0 && input.durationSeconds * 1000 > limits.max_duration_ms) return reject(`视频时长超过该功能上限 ${limits.max_duration_ms / 1000}s`);
  // 视频时长范围
  if (contentType === "2" && input.durationSeconds != null) {
    const duration = Number(input.durationSeconds);
    if (Number.isFinite(duration)) {
      const min = Number(config.min_time);
      const max = input.isVip ? Number(config.max_time) : Number(config.max_time_normal);
      if (Number.isFinite(min) && duration < min) return { ok: false, config, reason: `视频时长 ${duration}s 低于该功能下限 ${min}s` };
      if (Number.isFinite(max) && max > 0 && duration > max) return { ok: false, config, reason: `视频时长 ${duration}s 超过${input.isVip ? "会员" : "普通用户"}上限 ${max}s` };
    }
  }
  return { ok: true, config };
}

/**
 * 由 /task/query 应答的 data 推断任务所处阶段。新协议（2026-09 起）不再返回
 * data.status/process：完成态以 data.result 块是否出现为准（error_code===0 成功、
 * 非 0 失败、缺失 error_code 视作成功）；顶层 data.error_code 非 0 视为失败；
 * 旧协议 data.status 字段仍优先兼容。
 * @returns {{ phase: "running"|"finish"|"fail"|"unknown", status?: string, error_code?: number, msg?: string, reason?: string }}
 */
function taskState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { phase: "unknown" };
  // 旧协议：显式 status
  if (typeof data.status === "string" && data.status) {
    const status = String(data.status).toLowerCase();
    if (status === "finish" || status === "done" || status === "success" || status === "completed") {
      return { phase: "finish", status: data.status };
    }
    if (["fail", "failed", "error", "cancel", "cancelled", "canceled"].includes(status)) {
      return {
        phase: "fail",
        status: data.status,
        reason: data.error_msg || data.message || (data.result && data.result.error_msg) || undefined,
      };
    }
    return { phase: "running", status: data.status };
  }
  // 顶层 error_code（部分后端直接在 data 上带）
  const topCode = data.error_code == null ? Number.NaN : Number(data.error_code);
  if (!Number.isNaN(topCode) && topCode !== 0) {
    return { phase: "fail", reason: data.error_msg || `error_code=${topCode}` };
  }
  // 新协议：data.result 块出现即终态
  const result = data.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const resultCode = result.error_code == null ? Number.NaN : Number(result.error_code);
    // 29901 / error_msg="NOT_RESULT" 表示「结果尚未产出」，任务仍在进行中（pre 实测，
    // 处理中 result 块已存在但 media_info_list 为 null）；不能当成失败。
    if (resultCode === 29901 || String(result.error_msg || "").toUpperCase() === "NOT_RESULT") {
      return { phase: "running", error_code: resultCode, msg: result.error_msg };
    }
    if (!Number.isNaN(resultCode) && resultCode !== 0) {
      return { phase: "fail", reason: result.error_msg || `error_code=${resultCode}` };
    }
    return {
      phase: "finish",
      error_code: Number.isNaN(resultCode) ? undefined : resultCode,
      msg: result.error_msg || (result.parameter ? "success" : undefined),
    };
  }
  return { phase: "running" };
}

async function downloadResult(remoteUrl, output, options, log = () => {}) {
  async function run(redirects) {
    if (redirects > MAX_DOWNLOAD_REDIRECTS) throw new WinkError("too many result download redirects");
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    try {
      await fs.promises.access(output);
      if (!options.force) throw new WinkError(`output already exists: ${output}; pass force=true to replace it`);
    } catch (error) {
      if (error instanceof WinkError) throw error;
    }
    const temporary = path.join(
      path.dirname(output),
      `.${path.basename(output)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`,
    );
    const url = new URL(remoteUrl);
    const client = url.protocol === "https:" ? https : http;
    const digest = crypto.createHash("sha256");
    let size = 0;
    let contentType = "application/octet-stream";
    try {
      const response = await new Promise((resolve, reject) => {
        const req = client.get(url, { headers: { Accept: "*/*" } }, resolve);
        req.setTimeout((options.downloadTimeout || 120) * 1000, () => req.destroy(new WinkError("result download timed out")));
        req.on("error", reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return run(redirects + 1);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new WinkError(`result download failed with HTTP ${response.statusCode}`);
      }
      const declared = Number(response.headers["content-length"] || 0);
      const maxBytes = options.maxDownloadBytes || MAX_DOWNLOAD_BYTES;
      if (declared > maxBytes) {
        response.destroy();
        throw new WinkError(`result is larger than ${maxBytes} bytes`);
      }
      contentType = response.headers["content-type"] || contentType;
      const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
      const reportProgress = (done = false) => options.onProgress?.({ receivedBytes: size, totalBytes, done });
      reportProgress();
      const destination = fs.createWriteStream(temporary, { flags: "wx" });
      await new Promise((resolve, reject) => {
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new WinkError(`result exceeds ${maxBytes} bytes`));
            return;
          }
          digest.update(chunk);
          reportProgress();
        });
        response.on("error", reject);
        destination.on("error", reject);
        destination.on("finish", resolve);
        response.pipe(destination);
      });
      if (options.force) await fs.promises.rm(output, { force: true });
      await fs.promises.rename(temporary, output);
      reportProgress(true);
      return { path: output, size, sha256: digest.digest("hex"), content_type: contentType };
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error instanceof WinkError ? error : new WinkError(error.message);
    }
  }
  return run(0);
}

module.exports = { WinkClient, WinkError, UploadError, dataObject, responseOk, uploadAccessUrl, resultUrl, downloadResult, generateOnceCode, buildSubmitForm, buildQueryParams, buildAiTypeConfigParams, taskState, inferContentType, inferTaskType, checkAiTypeSupport, resolveGnumSync };
