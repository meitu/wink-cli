"use strict";

const assert = require("assert");
const {
  normalizeModel,
  detectClientModel,
  clearClientModelCache,
  looksAndroid,
  looksHarmony,
  looksIos,
} = require("../src/client_model");

function testNormalize() {
  assert.strictEqual(normalizeModel("  Apple   M4  "), "Apple M4");
  assert.strictEqual(normalizeModel(null), "");
  assert.strictEqual(normalizeModel("x".repeat(200)).length, 128);
}

function testDesktopDarwin() {
  clearClientModelCache();
  const model = detectClientModel({
    platform: "darwin",
    arch: "arm64",
    env: {},
    cpus: [{ model: "Apple M4" }],
    execFile: () => { throw new Error("should prefer cpu model"); },
    useCache: false,
  });
  assert.strictEqual(model, "Apple M4");
}

function testDesktopWindows() {
  clearClientModelCache();
  assert.strictEqual(detectClientModel({
    platform: "win32",
    arch: "x64",
    env: {},
    cpus: [{ model: "13th Gen Intel(R) Core(TM) i7-13700H" }],
    useCache: false,
  }), "13th Gen Intel(R) Core(TM) i7-13700H");

  assert.strictEqual(detectClientModel({
    platform: "win32",
    arch: "x64",
    env: {},
    cpus: [],
    execFile: (cmd) => {
      if (String(cmd).includes("powershell")) return "Latitude 5520\r\n";
      throw new Error("no wmic");
    },
    useCache: false,
  }), "Latitude 5520");
}

function testAndroidAndHarmony() {
  clearClientModelCache();
  assert.ok(looksAndroid({ ANDROID_ROOT: "/system" }));
  assert.ok(looksHarmony({ OHOS_ROOT: "/system" }));
  const props = { "ro.product.marketname": "Mate 60 Pro", "ro.product.model": "ALN-AL00" };
  assert.strictEqual(detectClientModel({
    platform: "linux",
    arch: "arm64",
    env: { ANDROID_ROOT: "/system" },
    cpus: [{ model: "unused" }],
    execFile: (_cmd, args) => props[args[0]] || "",
    useCache: false,
  }), "Mate 60 Pro");

  assert.strictEqual(detectClientModel({
    platform: "linux",
    arch: "arm64",
    env: { HARMONY_HOME: "/ohos" },
    cpus: [{ model: "unused" }],
    execFile: (_cmd, args) => (args[0] === "ro.product.model" ? "ALN-AL80" : ""),
    useCache: false,
  }), "ALN-AL80");
  assert.strictEqual(detectClientModel({
    platform: "darwin",
    arch: "arm64",
    env: { ILLEGAL_ACCESS_LIB_PATH: "/tmp/fake" },
    cpus: [{ model: "Apple M4" }],
    useCache: false,
  }), "Apple M4", "WorkBuddy sandbox marker must not force Harmony path");
}

function testIos() {
  clearClientModelCache();
  assert.ok(looksIos({ SIMULATOR_MODEL_IDENTIFIER: "iPhone16,2" }));
  assert.strictEqual(detectClientModel({
    platform: "darwin",
    arch: "arm64",
    env: { IOS_MODEL: "iPhone 15 Pro" },
    cpus: [{ model: "Apple M4" }],
    useCache: false,
  }), "iPhone 15 Pro");
}

function testFallback() {
  clearClientModelCache();
  assert.strictEqual(detectClientModel({
    platform: "linux",
    arch: "x64",
    env: {},
    cpus: [],
    useCache: false,
  }), "linux-x64");
}

function main() {
  testNormalize();
  testDesktopDarwin();
  testDesktopWindows();
  testAndroidAndHarmony();
  testIos();
  testFallback();
  console.log("client_model: Apple M4 / Windows CPU / Android / HarmonyOS / iOS detection passed");
}

main();
