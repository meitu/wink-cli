"use strict";

const { spawn } = require("child_process");

/** Best effort: callers print the link so it can still be opened manually. */
function openBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  try {
    let command = platform === "darwin" ? "open" : "xdg-open";
    let args = [url];
    const options = { stdio: "ignore", detached: true };
    if (platform === "win32") {
      // cmd/start interprets '&client_id=...' as a second command. Pass the URL
      // as data in the child environment, never interpolate it into shell code.
      command = "powershell.exe";
      const script = "Start-Process -FilePath $env:WINK_CLI_BROWSER_URL";
      args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      options.env = { ...process.env, WINK_CLI_BROWSER_URL: url };
      options.windowsHide = true;
    }
    const child = spawnProcess(command, args, options);
    child.on("error", () => {});
    child.unref();
  } catch (_) { /* Caller already printed the link for manual opening. */ }
}

module.exports = { openBrowser };
