"use strict";
// Canonical source: workbuddy/scripts/install_cli_from_git.cjs.
// Skill copies are checked byte-for-byte by test_install_cli_from_git.cjs.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const REPOSITORY = "https://github.com/meitu/wink-cli.git";

function run(command, args, { cwd, env, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: "inherit",
      detached: process.platform !== "win32" });
    let timedOut = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        if (result.status !== 0) child.kill();
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (_) { child.kill(); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const interrupt = () => { timedOut = true; stop(); };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const cleanup = () => { clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (timedOut) reject(new Error(`安装步骤超时或中断：${path.basename(command)}；本次进程已停止`));
      else if (code !== 0) reject(new Error(`安装步骤失败：${path.basename(command)}，退出码 ${code}`));
      else resolve();
    });
  });
}
function findNpm(node) {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(node), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")];
  const found = candidates.find(p => p && path.basename(p) === "npm-cli.js" && fs.existsSync(p));
  if (!found) throw new Error("找不到 npm-cli.js；请使用配套 Node/npm，或传入 --npm 的绝对路径");
  return found;
}
function version(v) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`无效版本：${v}`);
  return v.split(".").map(Number);
}
function checkVersion(v, minimum) {
  const a = version(v), b = version(minimum);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return; if (a[i] < b[i]) throw new Error(`CLI ${v} 低于要求 ${minimum}`); }
}
async function install(options = {}, dependencies = {}) {
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("需要 Node.js 18+");
  const node = process.execPath;
  const npm = options.npm || findNpm(node);
  if (!path.isAbsolute(npm) || !fs.existsSync(npm)) throw new Error("--npm 必须是已存在的 npm-cli.js 绝对路径");
  const prefix = path.resolve(options.prefix || path.join(os.homedir(), ".workbuddy/binaries/node/cli-connector-packages"));
  const minimum = options.minimum || "1.14.0";
  version(minimum);
  const execute = dependencies.run || run;
  const temporaryRoot = fs.realpathSync(dependencies.tempRoot || os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, "wink-git-install-"));
  const repository = path.join(temporary, "repository");
  try {
    const empty = path.join(temporary, "empty.npmrc");
    fs.writeFileSync(empty, "", { mode: 0o600 });
    const emptyGlobal = path.join(temporary, "empty-global.npmrc");
    fs.writeFileSync(emptyGlobal, "", { mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (["npm_config_userconfig", "npm_config_globalconfig", "npm_config_prefix", "npm_config_cache", "npm_execpath"].includes(key.toLowerCase())) delete env[key];
    }
    Object.assign(env, { npm_config_userconfig: empty, npm_config_globalconfig: emptyGlobal,
      npm_config_global: "false", npm_config_prefix: prefix, npm_config_cache: options.cache || path.join(temporary, "npm-cache"), npm_execpath: npm,
      PATH: path.dirname(node) + path.delimiter + (process.env.PATH || ""), GIT_TERMINAL_PROMPT: "0" });
    console.log("[1/4] 克隆官方 Wink CLI 仓库…");
    await execute("git", ["clone", "--depth", "1", "--", REPOSITORY, repository], { cwd: temporary, env, timeout: 120000 });
    const pkg = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
    if (pkg.name !== "wink-cli") throw new Error("克隆的仓库不是预期的 wink-cli 包");
    checkVersion(pkg.version, minimum);
    // npm also reads project configuration. This clone is disposable; isolate it
    // from any repository-provided npmrc without inspecting its contents.
    fs.rmSync(path.join(repository, ".npmrc"), { force: true });
    console.log("[2/4] 按锁文件安装依赖…");
    await execute(node, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig", empty],
      { cwd: repository, env, timeout: 180000 });
    console.log(`[3/4] 调用官方安装器，目标：${prefix}`);
    const args = [path.join(repository, "src/cli.js"), "install", "--prefix", prefix];
    if (options.skipSkills) args.push("--skip-skills");
    await execute(node, args, { cwd: temporary, env, timeout: 180000 });
    const installedRoot = path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "wink-cli");
    const installed = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
    if (installed.name !== "wink-cli" || installed.version !== pkg.version) throw new Error("安装结果与克隆版本不一致");
    if (fs.realpathSync(installedRoot).startsWith(temporary + path.sep)) throw new Error("安装结果仍指向临时目录，不能清理");
    console.log("[4/4] 核验已安装的 CLI…");
    const cli = path.join(installedRoot, "src/cli.js");
    await execute(node, [cli, "--version"], { cwd: temporary, env, timeout: 15000 });
    await execute(node, [cli, "--help"], { cwd: temporary, env, timeout: 15000 });
    console.log(`安装完成：${installed.version}；CLI 入口：${cli}`);
    return cli;
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("wink-git-install-")) throw new Error("拒绝清理非本次临时目录");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log("已删除本次克隆目录、临时依赖和配置。");
  }
}
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--skip-skills") options.skipSkills = true;
    else if (["--prefix", "--npm", "--cache", "--minimum"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) options[flag.slice(2)] = args[++i];
    else throw new Error(`无效参数：${flag}`);
  }
  return options;
}
if (require.main === module) {
  Promise.resolve().then(() => install(parse(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { install, run, parse };
