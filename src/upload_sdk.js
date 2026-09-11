"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const SDK_VERSION = "1.2.0.5";
const SIG_VERSION = "1.3";
const SIG_SECRET = "aTq3qEh_1ILmsPIt";
const SIG_SALT = "Tw5AY783H@EU3#XC";

const RELEASE_HOSTS = {
  0: ["https://strategy.app.meitudata.com/", "https://strategy-secondary.app.meituyun.com/"],
  1: ["https://strategy.stariidata.com/"],
  2: ["https://strategy.pixocial.com/"],
};
const TEST_HOSTS = {
  0: ["http://prestrategy.meitubase.com/"],
  1: ["http://prestrategy.stariidata.com/"],
  2: ["https://prestrategy.pixocial.com/"],
};

class UploadError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "UploadError";
    this.errorCode = options.errorCode ?? -9;
    this.extCode = options.extCode ?? 0;
    this.httpStatus = options.httpStatus ?? 0;
    this.retryable = options.retryable ?? (
      this.extCode === 0 && this.httpStatus !== 614 &&
      !(this.httpStatus >= 400 && this.httpStatus <= 499)
    );
  }
}

function platformName() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  if (process.env.ANDROID_ROOT) return "android";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

function generateSignature(requestPath, parameterValues, timestampMs = Date.now()) {
  const sigTime = String(timestampMs);
  const source = requestPath + parameterValues.map(String).sort().join("") +
    SIG_SECRET + sigTime + SIG_SALT;
  const digest = crypto.createHash("md5").update(source, "utf8").digest("hex");
  let signature = "";
  for (let index = 0; index < digest.length; index += 2) {
    signature += digest[index + 1] + digest[index];
  }
  return { sigTime, sigVersion: SIG_VERSION, sig: signature };
}

function urlsafeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

function remoteError(body) {
  const text = body.toString("utf8");
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { extCode: 0, message: text.slice(0, 2000) };
    }
    const rawCode = payload.err_code ?? payload.code ?? 0;
    const extCode = Number.isFinite(Number(rawCode)) ? Number(rawCode) : 0;
    const message = payload.err_msg ?? payload.error ?? payload.message ?? "";
    return { extCode, message: String(message) };
  } catch (_) {
    return { extCode: 0, message: text.slice(0, 2000) };
  }
}

function request(method, rawUrl, options = {}) {
  const url = new URL(rawUrl);
  const client = url.protocol === "https:" ? https : http;
  const headers = { ...(options.headers || {}) };
  const body = options.body == null ? null : Buffer.from(options.body);
  if (body && headers["Content-Length"] == null) headers["Content-Length"] = String(body.length);

  return new Promise((resolve, reject) => {
    const req = client.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          resolve({ status, body: responseBody, headers: res.headers });
          return;
        }
        const detail = remoteError(responseBody);
        reject(new UploadError(detail.message || `HTTP ${status}`, {
          extCode: detail.extCode,
          httpStatus: status,
        }));
      });
    });
    req.setTimeout(options.timeout ?? 30000, () => {
      req.destroy(new UploadError(`request timed out: ${rawUrl}`));
    });
    req.on("error", (error) => {
      reject(error instanceof UploadError ? error : new UploadError(`network request failed: ${error.message}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseJsonObject(body, operation) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new UploadError(`${operation} returned invalid JSON`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new UploadError(`${operation} returned a non-object JSON value`);
  }
  return payload;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tokenFileSizeLimit(token) {
  try {
    let encoded = String(token).split(":").pop().replace(/-/g, "+").replace(/_/g, "/");
    encoded += "=".repeat((4 - encoded.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return Number(payload.fsizeLimit || 0);
  } catch (_) {
    return 0;
  }
}

function parseTokenItem(name, value) {
  const token = String(value.token || "");
  return {
    name,
    token,
    key: String(value.key || ""),
    data: String(value.data || ""),
    bucket: String(value.bucket || ""),
    url: String(value.url || "").replace(/\/$/, ""),
    backupUrl: String(value.backup_url || "").replace(/\/$/, ""),
    accessUrl: String(value.access_url || ""),
    ttl: positiveInteger(value.ttl, 3600),
    chunkSize: positiveInteger(value.chunk_size, 256 * 1024),
    blockSize: positiveInteger(value.block_size, 4 * 1024 * 1024),
    threadNum: Number.parseInt(value.thread_num || 0, 10),
    connectTimeout: Number(value.connect_timeout || 0),
    socketTimeout: Number(value.socket_timeout || 0),
    fileSizeLimit: tokenFileSizeLimit(token),
  };
}

function multipartBody(boundary, fields, filename, data) {
  const chunks = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(String(value), "utf8"));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n",
    "utf8",
  ));
  chunks.push(data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function runConcurrent(count, concurrency, operation) {
  const results = new Array(count);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= count) return;
      results[index] = await operation(index);
    }
  }
  const workers = Array.from({ length: Math.min(count, Math.max(1, concurrency)) }, worker);
  await Promise.all(workers);
  return results;
}

class UploadClient {
  constructor(config = {}, options = {}) {
    this.config = {
      appKey: config.appKey ?? "wink",
      accessToken: config.accessToken ?? "",
      resourceType: config.resourceType ?? "media",
      suffix: config.suffix ?? "",
      environment: config.environment ?? 0,
      test: config.test ?? false,
      tokenCount: config.tokenCount ?? 5,
      formThreshold: config.formThreshold ?? 900 * 1024,
      maxRetries: config.maxRetries ?? 1,
      retryInterval: config.retryInterval ?? 0,
      chunkConcurrency: config.chunkConcurrency ?? 4,
      connectTimeout: config.connectTimeout ?? 10,
      socketTimeout: config.socketTimeout ?? 30,
      appVersion: config.appVersion ?? "",
      strategyHosts: config.strategyHosts ?? [],
    };
    if (!this.config.appKey) throw new TypeError("appKey must not be empty");
    if (!this.config.resourceType) throw new TypeError("resourceType must not be empty");
    this.transport = options.transport || { request };
    this.progress = options.progress || null;
    this.uploaded = 0;
  }

  hosts() {
    if (this.config.strategyHosts.length) return this.config.strategyHosts;
    const collection = this.config.test ? TEST_HOSTS : RELEASE_HOSTS;
    return collection[this.config.environment] || [];
  }

  async uploadFile(filename) {
    const absolutePath = path.resolve(filename);
    let stat;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (_) {
      throw new UploadError(`file does not exist: ${absolutePath}`, { errorCode: -4, retryable: false });
    }
    if (!stat.isFile()) throw new UploadError(`not a file: ${absolutePath}`, { errorCode: -4, retryable: false });
    if (stat.size === 0) throw new UploadError("上传内容为空", { errorCode: -6, retryable: false });
    const suffix = this.config.suffix || path.extname(absolutePath).slice(1).toLowerCase();
    const groups = await this.requestTokens(suffix);
    let lastError = null;
    for (const group of groups) {
      for (const item of group) {
        if (item.name === "oss" || item.name === "hw-s3") {
          lastError = new UploadError(`unsupported S3 upload strategy: ${item.name}`, { retryable: false });
          continue;
        }
        if (!item.token || !item.url) {
          lastError = new UploadError("upload policy is missing token or url", { retryable: false });
          continue;
        }
        if (item.fileSizeLimit > 0 && stat.size > item.fileSizeLimit) {
          throw new UploadError("大小超出限制，请修改后重试", { errorCode: -7, retryable: false });
        }
        try {
          this.uploaded = 0;
          const uploaded = stat.size <= this.config.formThreshold
            ? await this.formUpload(absolutePath, stat.size, item)
            : await this.multipartUpload(absolutePath, stat.size, item);
          if (item.accessUrl && uploaded.data.accessUrl == null) uploaded.data.accessUrl = item.accessUrl;
          if (item.key && uploaded.data.key == null) uploaded.data.key = item.key;
          return {
            ok: true,
            http_status: uploaded.status,
            data: uploaded.data,
            file: absolutePath,
            resource_type: this.config.resourceType,
            implementation: "nodejs",
          };
        } catch (error) {
          lastError = error;
          if (!(error instanceof UploadError) || !error.retryable) throw error;
        }
      }
    }
    if (lastError) throw lastError;
    throw new UploadError("token response contains no supported upload strategy", { errorCode: -16 });
  }

  async requestTokens(suffix) {
    const parameters = {
      count: String(this.config.tokenCount),
      app: this.config.appKey,
      type: this.config.resourceType,
      version: SDK_VERSION,
      "Access-Token": this.config.accessToken,
      app_version: this.config.appVersion,
      support_s3_upload: "false",
      platform: platformName(),
    };
    if (suffix) parameters.suffix = suffix;
    const signature = generateSignature("upload/policy", Object.values(parameters));
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (key !== "Access-Token") query.set(key, value);
    }
    for (const [key, value] of Object.entries(signature)) query.set(key, value);
    let lastError = null;
    for (const host of this.hosts()) {
      const policyUrl = new URL("upload/policy", host);
      policyUrl.search = query.toString();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await this.transport.request("GET", policyUrl.toString(), {
            headers: { Accept: "application/json", "Access-Token": this.config.accessToken },
            timeout: 15000,
          });
          return this.parseTokenGroups(JSON.parse(response.body.toString("utf8")));
        } catch (error) {
          lastError = error instanceof UploadError ? error : new UploadError(`token request failed: ${error.message}`, { errorCode: -16 });
          if (lastError.extCode !== 0) throw lastError;
        }
      }
    }
    if (lastError) {
      lastError.errorCode = -16;
      throw lastError;
    }
    throw new UploadError("failed to request upload policy", { errorCode: -16 });
  }

  parseTokenGroups(payload) {
    if (!Array.isArray(payload) || payload.length === 0) {
      throw new UploadError("token service returned no upload policy", { errorCode: -16 });
    }
    const groups = [];
    for (const policy of payload) {
      if (!policy || typeof policy !== "object" || !Array.isArray(policy.order)) continue;
      const items = [];
      for (const name of policy.order) {
        if (typeof name === "string" && policy[name] && typeof policy[name] === "object") {
          items.push(parseTokenItem(name, policy[name]));
        }
      }
      if (items.length) groups.push(items);
    }
    if (!groups.length) throw new UploadError("token service returned no usable upload policy", { errorCode: -16 });
    return groups;
  }

  async formUpload(filename, fileSize, item) {
    const data = await fs.promises.readFile(filename);
    const boundary = `----MTUpload${crypto.randomBytes(16).toString("hex")}`;
    const crc32 = crc32Buffer(data);
    const body = multipartBody(boundary, [
      ["key", item.key], ["token", item.token], ["crc32", String(crc32)],
    ], item.key || path.basename(filename), data);
    const response = await this.requestWithFailover(item, "POST", "", {
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body,
    });
    this.advance(fileSize, fileSize);
    return { data: parseJsonObject(response.body, "form upload"), status: response.status };
  }

  async multipartUpload(filename, fileSize, item) {
    const blockCount = Math.ceil(fileSize / item.blockSize);
    const workers = item.threadNum > 0 ? item.threadNum : this.config.chunkConcurrency;
    const contexts = await runConcurrent(blockCount, workers, (index) =>
      this.uploadBlock(filename, fileSize, item, index));
    const endpoint = `/mkfile/${fileSize}/mimeType/${urlsafeBase64("application/octet-stream")}` +
      `/key/${urlsafeBase64(item.key)}/fname/${urlsafeBase64(path.basename(filename))}`;
    const response = await this.requestWithFailover(item, "POST", endpoint, {
      headers: {
        Authorization: `UpToken ${item.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(contexts.join(","), "utf8"),
    });
    return { data: parseJsonObject(response.body, "mkfile"), status: response.status };
  }

  async uploadBlock(filename, fileSize, item, index) {
    const blockStart = index * item.blockSize;
    const blockSize = Math.min(item.blockSize, fileSize - blockStart);
    const handle = await fs.promises.open(filename, "r");
    let context = "";
    try {
      let offset = 0;
      while (offset < blockSize) {
        const length = Math.min(item.chunkSize, blockSize - offset);
        const chunk = Buffer.allocUnsafe(length);
        const result = await handle.read(chunk, 0, length, blockStart + offset);
        if (result.bytesRead !== length) throw new UploadError("file read ended unexpectedly", { errorCode: -3 });
        const expectedCrc = crc32Buffer(chunk);
        const endpoint = offset === 0 ? `/mkblk/${blockSize}` : `/bput/${context}/${offset}`;
        let payload = null;
        for (let crcAttempt = 0; crcAttempt < 2; crcAttempt += 1) {
          const response = await this.requestWithFailover(item, "POST", endpoint, {
            headers: {
              Authorization: `UpToken ${item.token}`,
              "Content-Type": "application/octet-stream",
            },
            body: chunk,
          });
          payload = parseJsonObject(response.body, "block upload");
          if (Number(payload.crc32) === expectedCrc) break;
          if (crcAttempt === 1) throw new UploadError("文件校验不通过", { errorCode: -17 });
        }
        context = String(payload.ctx || "");
        if (!context) throw new UploadError("block response is missing ctx");
        offset += length;
        this.advance(length, fileSize);
      }
      return context;
    } finally {
      await handle.close();
    }
  }

  async requestWithFailover(item, method, endpoint, options) {
    const hosts = [item.url];
    if (item.backupUrl && item.backupUrl !== item.url) hosts.push(item.backupUrl);
    const attempts = Math.max(1, this.config.maxRetries + 1);
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.transport.request(method, hosts[attempt % hosts.length] + endpoint, {
          ...options,
          timeout: (item.socketTimeout || this.config.socketTimeout) * 1000,
        });
      } catch (error) {
        lastError = error instanceof UploadError ? error : new UploadError(error.message);
        if (!lastError.retryable || attempt + 1 >= attempts) throw lastError;
        if (this.config.retryInterval > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.config.retryInterval * 1000));
        }
      }
    }
    throw lastError;
  }

  advance(amount, total) {
    this.uploaded += amount;
    if (this.progress) this.progress(Math.min(1, this.uploaded / total));
  }
}

// IEEE CRC-32, matching zlib.crc32 used by the C++ and Python implementations.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32Buffer(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

module.exports = {
  HttpResult: Object,
  UploadClient,
  UploadError,
  crc32Buffer,
  generateSignature,
  platformName,
  request,
};
