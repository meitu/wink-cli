"use strict";

const { spawn } = require("child_process");

/** Best effort: callers print the link so it can still be opened manually. */
function openBrowser(url, { platform = process.platform, spawnProcess = spawn,
  onError = error => process.stderr.write(`无法自动打开浏览器：${error.message}。请手动打开链接：${url}\n`),
} = {}) {
  let reported = false;
  const reportFailure = error => {
    if (reported) return;
    reported = true;
    onError(error);
  };
  try {
    let command = platform === "darwin" ? "open" : "xdg-open";
    let args = [url];
    const options = { stdio: "ignore", detached: true };
    if (platform === "win32") {
      // cmd/start interprets '&client_id=...' as a second command. Pass the URL
      // as data in the child environment, never interpolate it into shell code.
      command = "powershell.exe";
      // The helper is hidden, but the browser is an interactive window. Explicitly
      // request Normal so it does not inherit the helper's hidden window style.
      const script = "Start-Process -FilePath $env:WINK_CLI_BROWSER_URL -WindowStyle Normal -ErrorAction Stop";
      args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      options.env = { ...process.env, WINK_CLI_BROWSER_URL: url };
      options.windowsHide = true;
    }
    const child = spawnProcess(command, args, options);
    child.on("error", reportFailure);
    child.on("exit", (code, signal) => {
      if (code !== 0) reportFailure(new Error(`浏览器启动器退出（${signal || code}）`));
    });
    child.unref();
  } catch (error) { reportFailure(error); }
}

module.exports = { openBrowser };
