"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
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
    openBrowser(url, { platform, spawnProcess(command, args, options) {
      called++;
      assert.ok(!options.shell, "URLs must not go through a command shell");
      assert.strictEqual(options.stdio, "ignore");
      assert.strictEqual(options.detached, true);
      if (platform === "win32") {
        assert.strictEqual(command, "powershell.exe");
        assert.deepStrictEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        const script = Buffer.from(args[3], "base64").toString("utf16le");
        assert.strictEqual(script, "Start-Process -FilePath $env:WINK_CLI_BROWSER_URL");
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
assert.doesNotThrow(() => openBrowser(auth.auth_url, { spawnProcess() { throw new Error("fixture: unavailable"); } }));
console.log("browser opener: complete Windows auth/payment URLs, URL data isolation, macOS/Linux and launch failures passed");
