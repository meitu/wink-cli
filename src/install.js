"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { installAgentSkills } = require("./agent_skills");

const INSTALL_HELP = `wink-cli install — 安装 CLI，并为本机已有的 Agent 安装使用 Skill

用法:
  npx --yes meitu-wink-cli@${require("../package.json").version} install
  wink-cli install [--prefix <目录>] [--skill-dir <目录> | --skip-skills]

选项:
  --prefix <目录>   自定义 npm 安装前缀（需要自行将命令目录加入 PATH）
  --skill-dir <目录> 指定 Skill 根目录，在其下安装 wink-cli-usage（代替自动检测）
  --skip-skills      只安装 CLI，不写入 Agent 技能目录
  -h, --help        显示本帮助

安装后使用 wink-cli --help。需要 Node.js 18+ 和 npm，并能访问 npm 源；不需要 Git。
默认检测 Codex、Cursor、Claude Code、WorkBuddy 的已有配置目录。
Skill 入口读取当前安装 CLI 的完整说明；保留用户修改过或非本安装器创建的同名 Skill。
安装不会登录或投递云处理任务。`;

function npmCommand() {
  // npx supplies npm_execpath; invoking it with Node also avoids Windows .cmd quoting.
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const cli = candidates.find(file => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (cli) return [process.execPath, [cli]];
  if (process.platform !== "win32") return ["npm", []];
  throw new Error("未找到 npm，请安装包含 npm 的 Node.js，或使用 npx 运行安装命令。");
}

// Keep package contents intact; move command entries owned by a different
// Wink distribution only (GitHub wink-cli or npm meitu-wink-cli). npm otherwise rejects the renamed package with EEXIST.
function moveLegacyCommands(globalRoot, binDir, backupDir, packageName = require("../package.json").name) {
  const moves = [];
  for (const oldName of ["wink-cli", "wink-cli-v2", "meitu-wink-cli"]) {
    if (oldName === packageName) continue;
    const root = path.join(globalRoot, oldName);
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
    catch (_) { continue; }
    if (pkg.name !== oldName || pkg.bin?.["wink-cli"] !== "src/cli.js" ||
        !fs.existsSync(path.join(root, "skills/wink-cli-usage/SKILL.md"))) continue;
    for (const [command, entry] of Object.entries(require("../package.json").bin)) {
      if (pkg.bin?.[command] !== entry) continue;
      for (const suffix of ["", ".cmd", ".ps1"]) {
        const target = path.join(binDir, command + suffix);
        let stat;
        try { stat = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const owned = stat.isSymbolicLink()
          ? path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(root, entry)
          : stat.isFile() && stat.size < 32768 && fs.readFileSync(target, "utf8").replace(/\\/g, "/").includes(`node_modules/${oldName}/${entry}`);
        if (owned) moves.push({ target, backup: path.join(backupDir, `${oldName}-${command}${suffix}`) });
      }
    }
  }
  const moved = [];
  const restore = () => {
    for (const { target, backup } of moved.reverse()) {
      if (!fs.existsSync(backup) && !fs.lstatSync(backup, { throwIfNoEntry: false })) continue;
      if (!fs.lstatSync(target, { throwIfNoEntry: false })) fs.renameSync(backup, target);
    }
  };
  try {
    for (const move of moves) { fs.renameSync(move.target, move.backup); moved.push(move); }
  } catch (error) { restore(); throw error; }
  return restore;
}

function installCli(flags = {}) {
  const unknown = Object.keys(flags).filter(key => !["prefix", "skill-dir", "skip-skills", "help", "h"].includes(key));
  if (unknown.length) throw new Error(`install 不支持参数: ${unknown.map(key => `--${key}`).join(", ")}`);
  if (flags.prefix !== undefined && (typeof flags.prefix !== "string" || !flags.prefix.trim())) {
    throw new Error("--prefix 需要指定安装目录");
  }
  if (flags["skill-dir"] !== undefined && (typeof flags["skill-dir"] !== "string" || !flags["skill-dir"].trim())) {
    throw new Error("--skill-dir 需要指定 Skill 根目录");
  }
  if (flags["skip-skills"] !== undefined && flags["skip-skills"] !== true) throw new Error("--skip-skills 不接受参数值");
  if (flags["skip-skills"] && flags["skill-dir"]) throw new Error("--skip-skills 与 --skill-dir 不能同时使用");
  const prefixArgs = flags.prefix ? ["--prefix", path.resolve(flags.prefix)] : [];
  const [executable, leadingArgs] = npmCommand();
  function npm(args, inherit = false) {
    const result = spawnSync(executable, [...leadingArgs, ...args], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      stdio: inherit ? "inherit" : "pipe",
      windowsHide: true,
    });
    if (result.error) throw new Error(`无法运行 npm: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`npm ${args[0]} 失败（${result.signal || result.status}）。${result.stderr ? `\n${result.stderr.trim()}` : "请检查上方 npm 错误；权限不足时可用 --prefix 指定可写目录。"}`);
    }
    return result.stdout || "";
  }

  const prefix = npm(["prefix", "--global", ...prefixArgs]).trim();
  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-install-"));
  try {
    process.stdout.write(`正在安装 Wink CLI 到 ${prefix}…\n`);
    // Pack first: npm install -g <directory> would link into the disposable npx cache.
    const packed = JSON.parse(npm([
      "pack", path.resolve(__dirname, ".."), "--pack-destination", temp, "--json", "--ignore-scripts",
    ]));
    if (!packed[0] || !packed[0].filename || path.basename(packed[0].filename) !== packed[0].filename) {
      throw new Error("npm pack 未返回有效的安装包文件名");
    }
    const globalRoot = npm(["root", "--global", ...prefixArgs]).trim();
    const restoreLegacy = moveLegacyCommands(globalRoot, binDir, temp);
    try {
      npm(["install", "--global", path.join(temp, packed[0].filename), ...prefixArgs, "--no-audit", "--no-fund"], true);
    } catch (error) { restoreLegacy(); throw error; }
    process.stdout.write(`CLI 安装完成。命令目录: ${binDir}\n`);
    process.stdout.write("请在终端运行 wink-cli --help。若提示找不到命令，请将上述命令目录加入 PATH 后重新打开终端。\n");
    if (!flags["skip-skills"]) {
      try {
        const results = installAgentSkills({
          packageRoot: path.join(globalRoot, require("../package.json").name), skillDir: flags["skill-dir"],
        });
        const labels = { installed: "已安装", updated: "已更新", unchanged: "已是当前入口", skipped: "跳过", error: "失败" };
        for (const result of results) {
          process.stdout.write(`Skill ${labels[result.status]} [${result.agents.join(" / ")}]: ${result.directory}${result.message ? `（${result.message}）` : ""}\n`);
        }
        if (!results.length) process.stdout.write("未检测到支持的 Agent 配置目录；可用 --skill-dir 指定技能根目录后重新安装。\n");
        if (results.some(result => ["installed", "updated"].includes(result.status))) {
          process.stdout.write("请刷新 Agent 技能列表或新建会话；后续 Skill 内容随 CLI 升级，下次读取生效。\n");
        }
        if (results.some(result => result.status === "error")) {
          process.stderr.write("CLI 已安装，但部分 Agent Skill 写入失败，请检查上述目录后重试。\n");
          return 1;
        }
      } catch (error) {
        throw new Error(`CLI 已安装，但 Agent Skill 安装失败：${error.message}`);
      }
    }
    return 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { INSTALL_HELP, installCli, moveLegacyCommands };
