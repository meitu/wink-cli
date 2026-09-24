"use strict";

// Git installers depend on name=wink-cli and node_modules/wink-cli. Build the
// public npm distribution from a separate directory; never rewrite that contract.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_NAME = "meitu-wink-cli";

function stageNpmPackage(destination) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.name !== "wink-cli" || pkg.private !== true) throw new Error("Git 兼容包必须保持 name=wink-cli 和 private=true");
  fs.mkdirSync(destination, { recursive: true });
  for (const name of pkg.files) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`不支持的发布文件项：${name}`);
    fs.cpSync(path.join(ROOT, name), path.join(destination, name), { recursive: true,
      filter: source => {
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error("发布目录不允许符号链接");
        return true;
      } });
  }
  pkg.name = PUBLIC_NAME;
  delete pkg.private;
  // Tests/build scripts live in the repository, not the published package.
  delete pkg.scripts;
  fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return pkg;
}

function packNpmPackage(outputDirectory = path.join(ROOT, "dist")) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wink-npm-pack-"));
  try {
    const stage = path.join(temporary, "package");
    const pkg = stageNpmPackage(stage);
    const userConfig = path.join(temporary, "user.npmrc");
    const globalConfig = path.join(temporary, "global.npmrc");
    fs.writeFileSync(userConfig, ""); fs.writeFileSync(globalConfig, "");
    const candidates = [process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
      path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
    const npm = candidates.find(file => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
    if (!npm) throw new Error("未找到 npm-cli.js，请通过 npm run pack:npm 运行");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const result = spawnSync(process.execPath, [npm, "pack", stage, "--pack-destination", path.resolve(outputDirectory),
      "--ignore-scripts", "--json", "--userconfig", userConfig, "--globalconfig", globalConfig,
      "--cache", path.join(temporary, "cache")], { cwd: temporary, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm pack 失败：${result.stderr}`);
    const [packed] = JSON.parse(result.stdout);
    const filename = `${PUBLIC_NAME}-${pkg.version}.tgz`;
    if (packed?.name !== PUBLIC_NAME || packed.version !== pkg.version || packed.filename !== filename) {
      throw new Error("npm pack 的包名、版本或文件名不匹配");
    }
    return path.join(path.resolve(outputDirectory), filename);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { console.log(`npm 发布包：${packNpmPackage()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { stageNpmPackage, packNpmPackage };
