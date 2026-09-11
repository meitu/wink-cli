"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const INSTALL_HELP = `wink-cli install — 安装当前版本到 npm 全局目录

用法:
  npx github:meitu/wink-cli install
  wink-cli install [--prefix <目录>]

选项:
  --prefix <目录>   自定义 npm 安装前缀（需要自行将命令目录加入 PATH）
  -h, --help        显示本帮助

安装后使用 wink-cli --help。需要 Node.js 和 npm；从 GitHub 安装还需要 Git
及仓库访问权限。安装不会登录或投递云处理任务。`;

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

function installCli(flags = {}) {
  const unknown = Object.keys(flags).filter(key => !["prefix", "help", "h"].includes(key));
  if (unknown.length) throw new Error(`install 不支持参数: ${unknown.map(key => `--${key}`).join(", ")}`);
  if (flags.prefix !== undefined && (typeof flags.prefix !== "string" || !flags.prefix.trim())) {
    throw new Error("--prefix 需要指定安装目录");
  }
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
    npm(["install", "--global", path.join(temp, packed[0].filename), ...prefixArgs, "--no-audit", "--no-fund"], true);
    process.stdout.write(`安装完成。命令目录: ${binDir}\n`);
    process.stdout.write("请在终端运行 wink-cli --help。若提示找不到命令，请将上述命令目录加入 PATH 后重新打开终端。\n");
    return 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { INSTALL_HELP, installCli };
