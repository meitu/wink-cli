"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = require("../package.json").version;
const SKILL_NAME = "wink-cli-usage";
const SKILL_ROOT = path.resolve(__dirname, "../skills", SKILL_NAME);
const REFERENCES = Object.freeze({ "http-api": "references/http-api.md" });

const SKILL_HELP = `wink-cli skill — 读取当前已安装 CLI 随包发布的使用说明

用法:
  wink-cli skill
  wink-cli skill --reference http-api
  wink-cli skill --json

选项:
  --reference http-api   读取 HTTP 排障参考
  --json                 输出版本信息和 Markdown 内容的 JSON 对象
  -h, --help             显示本帮助

只读取安装包中的文档，不登录、不联网、不投递任务，也不修改 WorkBuddy 配置。
Skill 版本与当前 CLI 版本一致；CLI 升级后再次读取即获得新版本内容。`;

function readSkill(reference = null) {
  if (reference !== null && !Object.hasOwn(REFERENCES, reference)) {
    throw new Error("未知 Skill 参考文档；支持的值: http-api");
  }
  const file = path.join(SKILL_ROOT, reference === null ? "SKILL.md" : REFERENCES[reference]);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (_) {
    throw new Error("当前 CLI 安装包缺少 Skill 文档，请重新安装或升级 Wink CLI。");
  }
  if (!content.trim()) throw new Error("当前 CLI 的 Skill 文档为空，请重新安装或升级 Wink CLI。");
  if (reference === null) {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
    if (!frontmatter) throw new Error("当前 CLI 的 Skill 文档格式无效，请重新安装或升级 Wink CLI。");
    // package.json is the only release version source; do not maintain a second version in Markdown.
    const fields = frontmatter[1].split(/\r?\n/).filter(line => !/^version\s*:/.test(line));
    content = `---\n${fields.join("\n")}\nversion: ${VERSION}\n---\n${content.slice(frontmatter[0].length)}`;
  }
  return { name: SKILL_NAME, cli_version: VERSION, skill_version: VERSION, reference, content };
}

function cmdSkill(argv) {
  let reference = null;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json" && !json) {
      json = true;
    } else if ((arg === "--reference" || arg.startsWith("--reference=")) && reference === null) {
      reference = arg === "--reference" ? argv[++i] : arg.slice("--reference=".length);
      if (!reference || reference.startsWith("-")) throw new Error("--reference 需要指定参考文档: http-api");
      if (!Object.hasOwn(REFERENCES, reference)) throw new Error("未知 Skill 参考文档；支持的值: http-api");
    } else {
      throw new Error(`skill 不支持参数或参数重复: ${arg}`);
    }
  }
  if (help) {
    process.stdout.write(`${SKILL_HELP}\n`);
    return 0;
  }
  const document = readSkill(reference);
  process.stdout.write(json ? `${JSON.stringify(document, null, 2)}\n` : document.content.replace(/\n?$/, "\n"));
  return 0;
}

module.exports = { SKILL_HELP, readSkill, cmdSkill };
