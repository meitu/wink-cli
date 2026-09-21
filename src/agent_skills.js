"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");

const SKILL_NAME = "wink-cli-usage";
const MARKER = ".wink-cli-managed.json";
const VERSION = require("../package.json").version;
const TEMPLATE = path.resolve(__dirname, "../skills/wink-cli-usage/agent-entry.md");

function statOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; }
}

function directoryKey(directory) {
  // Resolve existing parent aliases as well, before a new skills/ directory is created.
  let key = path.resolve(directory);
  try {
    let parent = key;
    const suffix = [];
    while (!statOrNull(parent)) {
      suffix.unshift(path.basename(parent));
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    key = path.join(fs.realpathSync(parent), ...suffix);
  } catch (_) {
    // A broken link or unreadable root belongs to this target. Let installation
    // report it without preventing other, healthy Agent directories from updating.
  }
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function detectAgentSkillTargets({ home = os.homedir(), env = process.env } = {}) {
  const targets = new Map();
  const shared = path.join(home, ".agents", "skills");
  function add(root, agent, detectionError) {
    root = path.resolve(root);
    const key = directoryKey(root);
    if (!targets.has(key)) targets.set(key, { root, agents: [], ...(detectionError ? { detectionError } : {}) });
    else if (!detectionError) delete targets.get(key).detectionError;
    targets.get(key).agents.push(agent);
  }
  function detect(config, root, agent) {
    try { if (isDirectory(config)) add(root, agent); }
    catch (error) { add(root, agent, `无法检查 Agent 配置目录 ${config}：${error.message}`); }
  }
  detect(env.CODEX_HOME || path.join(home, ".codex"), shared, "codex");
  detect(path.join(home, ".cursor"), shared, "cursor");
  if (!targets.has(directoryKey(shared))) detect(shared, shared, "shared");
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  detect(claude, path.join(claude, "skills"), "claude");
  const workbuddy = env.WORKBUDDY_CONFIG_DIR || path.join(home, ".workbuddy");
  detect(workbuddy, path.join(workbuddy, "skills"), "workbuddy");
  return [...targets.values()];
}

function quoteCommandArgument(value, platform) {
  if (/[\r\n\0]/.test(value)) throw new Error("Skill 命令路径不能包含换行或空字符");
  return platform === "win32" ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

function renderAgentSkill(packageRoot, nodePath, platform) {
  const cli = path.join(packageRoot, "src", "cli.js");
  const command = `${platform === "win32" ? "& " : ""}${quoteCommandArgument(nodePath, platform)} ${quoteCommandArgument(cli, platform)} skill`;
  return fs.readFileSync(TEMPLATE, "utf8")
    .replace("{{SHELL}}", platform === "win32" ? "powershell" : "bash")
    .replace("{{READ_COMMAND}}", () => command);
}

function digest(content) { return createHash("sha256").update(content).digest("hex"); }

function inspectManaged(directory) {
  const stat = statOrNull(directory);
  if (!stat) return { exists: false };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { skip: "同名目标不是普通目录，已保留" };
  const markerFile = path.join(directory, MARKER);
  if (!statOrNull(markerFile)?.isFile()) return { skip: "已有同名 Skill 不由 Wink CLI 管理，已保留" };
  const allowed = new Set(["SKILL.md", MARKER, "_user_meta.json"]);
  if (fs.readdirSync(directory).some(name => !allowed.has(name))) return { skip: "目录含用户新增文件，已保留" };
  for (const file of ["SKILL.md", MARKER, "_user_meta.json"]) {
    const entry = statOrNull(path.join(directory, file));
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) return { skip: "目录含非普通文件，已保留" };
  }
  let marker, userMeta;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    if (statOrNull(path.join(directory, "_user_meta.json"))) {
      userMeta = JSON.parse(fs.readFileSync(path.join(directory, "_user_meta.json"), "utf8"));
      if (!userMeta || Array.isArray(userMeta) || typeof userMeta !== "object") throw new Error("metadata");
    }
  } catch (_) { return { skip: "管理标记或平台元数据不可识别，已保留" }; }
  if (!marker || marker.owner !== "wink-cli" || marker.schema !== 1 || marker.skill !== SKILL_NAME ||
      !marker.files || Object.keys(marker.files).join() !== "SKILL.md") {
    return { skip: "已有同名 Skill 的管理标记不匹配，已保留" };
  }
  const contentFile = path.join(directory, "SKILL.md");
  if (!statOrNull(contentFile) || digest(fs.readFileSync(contentFile)) !== marker.files["SKILL.md"]) {
    return { skip: "Skill 已被用户修改，已保留" };
  }
  return { exists: true, marker, userMeta };
}

function installTarget(target, { content, version }) {
  const directory = path.join(target.root, SKILL_NAME);
  const result = { directory, agents: target.agents };
  function finish(status, message) {
    result.status = status;
    if (message) result.message = message;
    return result;
  }
  let staged, backup, oldMoved = false;
  try {
    const old = inspectManaged(directory);
    if (old.skip) return finish("skipped", old.skip);
    const marker = { schema: 1, owner: "wink-cli", skill: SKILL_NAME, cli_version: version, files: { "SKILL.md": digest(content) } };
    let userMeta = old.userMeta;
    if (target.agents.includes("workbuddy") || userMeta) {
      userMeta = { ...userMeta, name: "Wink CLI 使用说明", source: "userImport", version };
      if (!Number.isFinite(userMeta.installedAt) || userMeta.installedAt <= 0) userMeta.installedAt = Date.now();
    }
    if (old.exists && JSON.stringify(old.marker) === JSON.stringify(marker) &&
        JSON.stringify(old.userMeta) === JSON.stringify(userMeta)) return finish("unchanged");
    fs.mkdirSync(target.root, { recursive: true });
    staged = fs.mkdtempSync(path.join(target.root, ".wink-cli-stage-"));
    fs.writeFileSync(path.join(staged, "SKILL.md"), content);
    fs.writeFileSync(path.join(staged, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    if (userMeta) fs.writeFileSync(path.join(staged, "_user_meta.json"), `${JSON.stringify(userMeta, null, 2)}\n`);
    const latest = inspectManaged(directory);
    if (latest.skip || JSON.stringify(latest) !== JSON.stringify(old)) {
      return finish("skipped", "安装期间目录已改变，已保留");
    }
    if (old.exists) {
      backup = fs.mkdtempSync(path.join(target.root, ".wink-cli-backup-"));
      fs.renameSync(directory, path.join(backup, "previous"));
      oldMoved = true;
    }
    fs.renameSync(staged, directory);
    staged = null;
    oldMoved = false;
    return finish(old.exists ? "updated" : "installed");
  } catch (error) {
    if (oldMoved) {
      try { fs.renameSync(path.join(backup, "previous"), directory); oldMoved = false; }
      catch (_) { return finish("error", `${error.message}；原 Skill 备份保留在 ${backup}`); }
    }
    return finish("error", error.message);
  } finally {
    for (const temporary of [staged, backup && !oldMoved ? backup : null]) {
      if (!temporary) continue;
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch (error) {
        // Keep processing other Agents even if temporary-directory cleanup is denied.
        result.status = "error";
        result.message = `${result.message ? `${result.message}；` : ""}临时目录清理失败 ${temporary}：${error.message}`;
      }
    }
  }
}

function installAgentSkills({ packageRoot, home = os.homedir(), env = process.env, platform = process.platform,
  nodePath = process.execPath, skillDir, expectedVersion = VERSION }) {
  if (!packageRoot || !path.isAbsolute(packageRoot)) throw new Error("CLI 安装包目录必须为绝对路径");
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "wink-cli" || pkg.version !== expectedVersion) throw new Error(`已安装 CLI 版本不匹配，要求 ${expectedVersion}`);
  for (const file of ["src/cli.js", "skills/wink-cli-usage/SKILL.md"]) {
    if (!fs.statSync(path.join(packageRoot, file)).isFile()) throw new Error(`CLI 安装包缺少 ${file}`);
  }
  const content = renderAgentSkill(packageRoot, nodePath, platform);
  const targets = skillDir ? [{ root: path.resolve(skillDir), agents: ["custom"] }] : detectAgentSkillTargets({ home, env });
  return targets.map(target => target.detectionError
    ? { directory: path.join(target.root, SKILL_NAME), agents: target.agents, status: "error", message: target.detectionError }
    : installTarget(target, { content, version: pkg.version }));
}

module.exports = { detectAgentSkillTargets, installAgentSkills, renderAgentSkill };
