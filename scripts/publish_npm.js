"use strict";

// Publish the public npm distribution without rewriting the Git root package
// (name stays wink-cli / private=true). Staging to meitu-wink-cli happens only
// inside pack_npm.js temporary directories.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { packNpmPackage } = require("./pack_npm");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_NAME = "meitu-wink-cli";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

function readRootPackage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.name !== "wink-cli" || pkg.private !== true) {
    throw new Error("仓库根包必须保持 name=wink-cli 且 private=true；禁止为发布改根目录包名");
  }
  return pkg;
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const npm = candidates.find((file) => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (!npm) throw new Error("未找到 npm-cli.js；请用 Node 自带 npm，或设置 npm_execpath");
  return npm;
}

function runNode(args, { cwd = ROOT, inherit = true } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = inherit ? "" : `${result.stderr || result.stdout || ""}`.trim();
    throw new Error(`命令失败（${result.status}）：node ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    registry: DEFAULT_REGISTRY,
    dryRun: false,
    skipTests: false,
    skipPack: false,
    yes: false,
    otp: undefined,
    tarball: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--skip-tests") options.skipTests = true;
    else if (flag === "--skip-pack") options.skipPack = true;
    else if (flag === "--yes" || flag === "-y") options.yes = true;
    else if (flag === "--registry" && argv[i + 1] && !argv[i + 1].startsWith("--")) options.registry = argv[++i];
    else if (flag === "--otp" && argv[i + 1] && !argv[i + 1].startsWith("--")) options.otp = argv[++i];
    else if (flag === "--tarball" && argv[i + 1] && !argv[i + 1].startsWith("--")) options.tarball = path.resolve(argv[++i]);
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`无效参数：${flag}`);
  }
  if (options.skipPack && options.tarball) throw new Error("--skip-pack 与 --tarball 不能同时使用");
  return options;
}

function helpText(version) {
  return `publish_npm — 打包并发布 meitu-wink-cli@${version} 到 npm

不会修改仓库根 package.json（始终保持 name=wink-cli、private=true）。
包名改写只发生在 pack_npm 的临时目录中。

用法:
  node scripts/publish_npm.js [选项]
  npm run publish:npm -- [选项]

选项:
  --dry-run       打包后执行 npm publish --dry-run，不实际上传
  --skip-tests    跳过 npm test（仍会打包）
  --skip-pack     使用已有 dist/${PUBLIC_NAME}-<version>.tgz，不再重新打包
  --tarball <路径> 发布指定 tarball（跳过打包）
  --registry <url> npm 源，默认 ${DEFAULT_REGISTRY}
  --otp <code>    双因素验证码（若账号启用 2FA）
  --yes, -y       跳过交互确认
  -h, --help      显示本帮助
`;
}

function resolveTarball(pkg, options) {
  if (options.tarball) {
    if (!fs.existsSync(options.tarball)) throw new Error(`找不到 tarball：${options.tarball}`);
    return options.tarball;
  }
  const expected = path.join(ROOT, "dist", `${PUBLIC_NAME}-${pkg.version}.tgz`);
  if (options.skipPack) {
    if (!fs.existsSync(expected)) {
      throw new Error(`找不到已打包文件：${expected}；先去掉 --skip-pack 或传入 --tarball`);
    }
    return expected;
  }
  if (!options.skipTests) {
    console.log("[1/3] 运行测试…");
    runNode([findNpmCli(), "test"], { cwd: ROOT, inherit: true });
  } else {
    console.log("[1/3] 已跳过测试（--skip-tests）");
  }
  console.log(`[2/3] 打包公开 npm 发行包（临时目录内改名为 ${PUBLIC_NAME}）…`);
  const before = fs.readFileSync(path.join(ROOT, "package.json"));
  const archive = packNpmPackage(path.join(ROOT, "dist"));
  const after = fs.readFileSync(path.join(ROOT, "package.json"));
  if (!before.equals(after)) throw new Error("打包后根 package.json 被改动，已中止发布");
  if (path.resolve(archive) !== path.resolve(expected)) {
    throw new Error(`打包输出不符合预期：${archive}`);
  }
  return archive;
}

function confirmPublish({ pkg, archive, registry, dryRun, yes }) {
  if (dryRun) return;
  if (!yes && !process.stdin.isTTY) {
    throw new Error("非交互环境发布需要加 --yes");
  }
  if (yes) return;
  process.stdout.write(
    `\n即将发布：\n  包名    ${PUBLIC_NAME}@${pkg.version}\n  文件    ${archive}\n  源      ${registry}\n确认发布？输入 yes 继续：`,
  );
  const buffer = Buffer.alloc(64);
  const bytes = fs.readSync(0, buffer, 0, buffer.length, null);
  const answer = buffer.slice(0, bytes).toString("utf8").trim().toLowerCase();
  if (answer !== "yes") throw new Error("已取消发布");
}

function runNpmPublish(archive, options) {
  const npm = findNpmCli();
  const args = ["publish", archive, "--access", "public", "--registry", options.registry];
  if (options.dryRun) args.push("--dry-run");
  if (options.otp) args.push("--otp", options.otp);
  console.log(`[3/3] ${options.dryRun ? "dry-run 发布" : "发布"} ${path.basename(archive)} …`);
  // Publish needs the caller's npm auth; do not isolate userconfig here.
  runNode([npm, ...args], { cwd: ROOT, inherit: true });
}

function verifyPublished(pkg, options) {
  if (options.dryRun) {
    console.log("dry-run 完成；未上传到 npm。");
    return;
  }
  const npm = findNpmCli();
  const result = spawnSync(
    process.execPath,
    [npm, "view", `${PUBLIC_NAME}@${pkg.version}`, "version", "--registry", options.registry],
    { cwd: ROOT, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    console.warn(`发布命令已返回成功，但暂时无法核验远端版本：${(result.stderr || result.stdout || "").trim()}`);
    return;
  }
  if (result.stdout.trim() !== pkg.version) {
    throw new Error(`远端版本核验失败：期望 ${pkg.version}，得到 ${result.stdout.trim()}`);
  }
  console.log(`发布完成：${PUBLIC_NAME}@${pkg.version}`);
  console.log(`安装：npx --yes ${PUBLIC_NAME}@${pkg.version} install`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const pkg = readRootPackage();
  if (options.help) {
    process.stdout.write(helpText(pkg.version));
    return 0;
  }
  const rootBefore = fs.readFileSync(path.join(ROOT, "package.json"));
  try {
    const archive = resolveTarball(pkg, options);
    confirmPublish({ pkg, archive, registry: options.registry, dryRun: options.dryRun, yes: options.yes });
    runNpmPublish(archive, options);
    verifyPublished(pkg, options);
  } finally {
    const rootAfter = fs.readFileSync(path.join(ROOT, "package.json"));
    if (!rootBefore.equals(rootAfter)) {
      throw new Error("发布过程中根 package.json 被改动；请检查工作区，Git 契约要求保持 name=wink-cli");
    }
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, readRootPackage, resolveTarball, main, PUBLIC_NAME, DEFAULT_REGISTRY };
