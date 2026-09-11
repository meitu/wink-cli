"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { spawnSync } = require("child_process");
const { openBrowser } = require("../src/open_browser");
const { WinkClient } = require("../src/wink_client");
const { PAYMENT_URLS } = require("../src/beans");

const auth = new WinkClient({ baseUrl: "https://precliapi-winkcut.meitu.com" })
  .authUrl("abcdefghijklmnopqrstuvwx01234567", "1189857724");
const urls = [auth.auth_url, ...Object.values(PAYMENT_URLS),
  'https://example.invalid/?a=1&b=%26&quote="\'&cmd=%PATH%^!中文'];
const previous = process.env.WINK_CLI_BROWSER_URL;
for (const platform of ["win32", "darwin", "linux"]) {
  for (const url of urls) {
    let called = 0, detached = false;
    openBrowser(url, { platform, onError: () => {}, spawnProcess(command, args, options) {
      called++;
      assert.ok(!options.shell, "URLs must not go through a command shell");
      assert.strictEqual(options.stdio, "ignore");
      assert.strictEqual(options.detached, platform !== "win32");
      if (platform === "win32") {
        assert.strictEqual(command, "powershell.exe");
        assert.deepStrictEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        const script = Buffer.from(args[3], "base64").toString("utf16le");
        assert.strictEqual(script, "Start-Process -FilePath $env:WINK_CLI_BROWSER_URL -WindowStyle Normal -ErrorAction Stop");
        assert.strictEqual(options.windowsHide, true, "only the helper window should be hidden");
        assert.ok(!script.includes(url), "URL data must never become PowerShell source code");
        assert.strictEqual(options.env.WINK_CLI_BROWSER_URL, url, "preserve all query parameters");
        if (url === auth.auth_url) {
          const forwarded = new URL(options.env.WINK_CLI_BROWSER_URL);
          assert.strictEqual(forwarded.searchParams.get("client_id"), "1189857724");
          assert.strictEqual(forwarded.searchParams.get("once_code"), auth.once_code);
        }
      } else {
        assert.strictEqual(command, platform === "darwin" ? "open" : "xdg-open");
        assert.deepStrictEqual(args, [url]);
      }
      const child = new EventEmitter();
      child.unref = () => { detached = true; };
      process.nextTick(() => child.emit("error", new Error("fixture: browser unavailable")));
      return child;
    } });
    assert.strictEqual(called, 1);
    assert.ok(detached);
  }
}
assert.strictEqual(process.env.WINK_CLI_BROWSER_URL, previous, "do not mutate the parent environment");
if (process.platform === "win32") {
  // Exercise real PowerShell startup without opening a browser. DETACHED_PROCESS
  // used to return exit 0 while silently skipping even this harmless script.
  openBrowser(auth.auth_url, { spawnProcess(command, args, options) {
    const probeArgs = [...args];
    probeArgs[3] = Buffer.from("Write-Output wink-browser-launch-probe", "utf16le").toString("base64");
    const result = spawnSync(command, probeArgs, {
      ...options, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /wink-browser-launch-probe/);
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  }, onError: error => { throw error; } });
}
const failures = [];
openBrowser(auth.auth_url, {
  spawnProcess() { throw new Error("fixture: unavailable"); },
  onError: error => failures.push(error.message),
});
assert.deepStrictEqual(failures, ["fixture: unavailable"]);
for (const event of ["error", "exit", "signal", "success"]) {
  const child = new EventEmitter();
  child.unref = () => {};
  const errors = [];
  openBrowser(auth.auth_url, { spawnProcess: () => child, onError: error => errors.push(error.message) });
  if (event === "error") {
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("exit", -1, null);
  } else if (event === "signal") child.emit("exit", null, "SIGTERM");
  else child.emit("exit", event === "success" ? 0 : 1, null);
  assert.strictEqual(errors.length, event === "success" ? 0 : 1, "report launch failures exactly once");
}
console.log("browser opener: complete Windows auth/payment URLs, URL data isolation, macOS/Linux and launch failures passed");
