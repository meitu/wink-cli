---
name: wink-cli-usage
display_name: Wink CLI 使用说明
display_name_en: Wink CLI Usage
description_zh: 指导 AI 正确调用 wink-cli 命令行完成图片与视频云处理：命令与档位选择、参数含义、输入输出规范、结构化结果解析、退出码判定与失败恢复。
description_en: Teaches the AI how to drive the wink-cli command line for cloud image and video processing — command and level selection, parameters, input/output rules, JSON result parsing, exit-code handling and failure recovery.
category: 效率工具
author: 美图
---

# Wink CLI 使用说明

本说明由当前安装的 wink-cli 随包提供，可供 WorkBuddy 的「Wink」连接器以及其他 Agent 调用。通过 `wink-connector skill` 读取时，Skill 版本自动取自 CLI 的 package.json，与 CLI 一起升级。每次新任务先读取当前文档；CLI 更新后重新读取，不沿用旧会话中的参数表。Windows 可使用 `wink-connector.cmd skill`。

CLI 可以独立安装并完成授权登录；WorkBuddy 也可通过连接器安装与认证。本文说明命令与档位选择、参数、结果判定和失败处理。CLI 帮助是实际支持参数的最终依据。

默认使用简体中文；用户明确指定其他语言时跟随用户。

## 一、前置：先做一次环境自检

业务命令执行前，先确认运行时与登录态：

```bash
wink-connector doctor --json
```

返回字段含义：

| 字段 | 含义 | 判定 |
|---|---|---|
| `ok` | Node.js 版本是否达标 | `false` 时停止任务，如实告知需要 Node.js 18 或以上 |
| `node` / `node_min` | 当前与最低 Node 版本 | 参考值 |
| `cli_version` / `skill_version` | 当前 CLI 与随包 Skill 版本 | 应一致 |
| `skill_command` | 当前平台读取 Skill 的命令 | CLI 更新后重新执行 |
| `base_url` | 当前服务地址 | 应为正式环境地址 |
| `logged_in` | 本地是否已有凭据 | 在线有效性由服务端判断；`false` 时先完成授权 |

同时确认 `wink-cli --version` 与正在读取的 Skill 所属 CLI 版本一致。命令不存在、版本不足或连接器安装失败导致 CLI 不可用时，运行一次 `npx github:meitu/wink-cli install`（Windows 可用 `npx.cmd`），等待安装完成后重新核验。WorkBuddy 市场搜不到 Wink 时也使用此兜底；已有可用 CLI 时直接复用，不要求先连接市场条目。

安装需要 Node.js 18+、npm 和 Git。依赖缺失、网络或安装失败时报告真实错误和“尚未提交”，不循环安装。若 PATH 仍命中旧版本，用 `npm root -g` 找到当前 npm 的全局包目录，以 `node "<全局包目录>/wink-cli/src/cli.js" ...` 和 `node "<全局包目录>/wink-cli/connector/wink-connector.js" ...` 使用同一安装包；核验版本并重新读取本说明，不使用临时 npx 缓存路径。独立业务 Skill 的功能、档位和用户选择不因安装兜底改变；不要绕过 CLI 直连接口。

## 二、认证前置条件

- 凭据由连接器与 CLI 共同管理，落盘在 `~/.wink-mcp-server/cli-credentials/`，**不要读取、回显或转述其中内容**。
- 未登录时执行 `wink-connector login`（Windows 使用 `.cmd`；已解析绝对入口则沿用该入口）；连接器面板可用时也可由面板授权。将实际授权链接显示为“前往授权”超链接，保持同一进程等待成功或超时，不重复启动。`wink-connector status` 的 `WINK_AUTH=connected` 仅说明本地有凭据，退出码 0 不代表已登录。授权成功后沿用本轮素材与参数继续处理，无需重新上传。业务命令首次发现未登录也会自动进入授权等待。凭据明确失效时可使用 `--relogin` 完成一次重新授权；应用或环境权限问题按真实错误处理，不反复登录。
- **禁止**向用户索要 api_key、once_code 或把凭据贴进对话。用户主动贴入时提醒其注意泄露风险。

## 三、命令与档位

所有业务命令形态一致：

```bash
wink-cli <命令> [--level <n>] --input "<绝对路径>" [专属参数] --json
```

| 命令 | 功能 | 档位（`--level`） |
|---|---|---|
| `picture_quality` | 画质修复 | 1 高清 / 2 超清（默认）/ 3 人像增强 / 4 AI超清 / 5 商品图 / 6 文字图表 / 7 游戏 / 8 动漫 / 9 高糊图 / 10 演唱会 / 11 专业级修复 / 12 AIGC精修 |
| `video_repair` | 视频全能修复 | Pro 单档，仅视频，无需 `--level`；CLI 1.11.0 起支持 |
| `resolution_repair` | 分辨率修复 | 单档位，用 `--sr-mode` 选目标分辨率 |
| `remove_watermark` | 消除水印 | 1 自动去印（默认）/ 2 AI去水印 |
| `denoise` | 降噪 | 单档位 |
| `color_enhance` | 色彩增强 | 单档位 |
| `color_unite` | 色调统一 | 单档位，需 `--reference` |
| `cartoon` | AI动漫 | 单档位 |
| `night_scene` | 夜景提升 | 单档位 |
| `video_frame` | 视频补帧 | 1 补帧（默认）/ 2 补帧2.0 / 3 AIGC补帧 |
| `ai_translation` | AI翻译 | 单档位 |
| `ai_beauty` | AI美容 | 单档位 |
| `video_defogging` | 视频去雾 | 单档位 |
| `old_photo` | 老照片修复 | 用 `--variant` 选 standard / quality / shared |

**档位与媒体类型强绑定**：部分档位仅支持图片（如 5 商品图、6 文字图表、9 高糊图），部分仅支持视频（如 `video_frame`、`ai_translation`、`video_defogging`）。给视频选仅图片档位会在上传前直接报错，不要盲目重试。

单档位功能可省略 `--level`，显式写 `--level 1` 也兼容。任何命令的准确档位表以 `wink-cli <命令> --help` 为准，不确定时先查帮助。

视频全能修复调用 `wink-cli video_repair --input "/绝对路径/video.mp4" --json`。首次使用先检查 `wink-cli video_repair --help`；旧 CLI 不支持时需先发布并安装 1.11.0 或更高版本，不改用 `picture_quality --level 11/12`。动态 Skill 入口要求 CLI 1.13.0 或更高版本；新连接器上线前须先发布依赖的 CLI。

全能修复按 `task_type=2`、`func_id=65591`、视频 `content_type=2` 匹配云处理配置，使用返回的算法 type（2026-09-17 正式环境为 123）；默认开启抖动检测。每个视频只有一个任务，不自动串联其他功能；无强度、FPS、分辨率或工作流开关参数，整段视频超过 CLI 能力检查上限时说明限制，不静默裁剪。图片智能校色不在此视频流程内。

## 四、专属参数

| 命令 | 参数 | 取值 |
|---|---|---|
| `resolution_repair` | `--sr-mode <n>` | `0`=720p / `1`=1080p（默认）/ `2`=2K / `3`=4K / `4`=8K |
| `denoise` | `--strength <v>` | `low`（默认）/ `median` / `high` |
| `night_scene` | `--strength <v>` | `low`=中（默认）/ `median`=高 |
| `color_unite` | `--reference <path>` | 参考图片绝对路径，必填，仅 JPG/PNG/WebP |
| `cartoon` | `--style <id>`、`--formula-type <id>` | 均必填，且必须与当前环境已上线的风格物料一致 |
| `cartoon` | `--max-edge <n>` | `960`（默认）/ `1080` / `1280` / `1920` |
| `video_frame` | `--fps <n>` 或 `--factor <n>` | 二选一，不可同用；都不填由服务端决定 |
| `ai_translation` | `--target-language <code>` | 必填，如 `en`；`--source-language` 默认 `zh` |
| `ai_beauty` | `--list-styles [--json]` | 获取当前真实风格列表，不投递任务 |
| `ai_beauty` | `--style <material_id>` 或 `--gender male/female` | 指定实时物料 ID，或按用户指定性别偏好随机选择适用风格，二选一 |
| `ai_beauty` | `--hair-silky`、`--beauty-double-chin` | 发质柔顺、去双下巴，默认关闭，可单独使用或与风格组合 |
| `old_photo` | `--variant <v>` | `standard`（默认）/ `quality` / `shared` |
| `old_photo` | `--workflow-params <json>` | 覆盖修复开关，JSON 或 `@文件路径` |

`--translate-params`、`--workflow-params` 可直接传 JSON，也可传 `@/绝对路径/config.json` 从文件读取。

**AI 美容流程**：先询问用户是否需要去双下巴、头发柔顺（已明确回答的不重复询问），然后运行 `wink-cli ai_beauty --list-styles --json`，展示风格名称及适用媒体范围供选择。将用户选择映射到真实 `material_id`，使用 `--style` 投递，只加用户开启的附加效果。不要将列表序号当物料 ID，也不要推断用户性别。

用户明确要求按性别随机选风格时，可使用 `--gender`（兼容 `-gender`）：`male` 对应少年、绅士、硬朗、浪漫；`female` 对应自然、减龄、裸感、女高、浓颜、欧美、紧致。CLI 每次拉取列表，筛掉媒体不适用及配置无效的风格，再为每个文件随机选择；无候选时停止，不擅自更换性别。只有附加效果时也允许不选风格。

风格配置由 CLI 从服务端 `material_conf.beauty_style` 读取，并兼容旧 `parameter` 字段，禁止手写或猜测美容参数；旧 `--retouch-params` 已不支持。`cartoon` 仍需要当前环境的真实 `--style` 与 `--formula-type`，缺少时不要编造。

上表是 CLI 自身默认值。具体专家或业务 Skill 明确了默认目标时，必须显式传参；例如超分 Skill 默认4K时传 `--sr-mode 3`，1080p专家传 `--sr-mode 1`，降噪 Skill 默认 `--strength high`，夜景增强 Skill 默认 `--strength median`。用户明确指定目标优先于专家默认值，专家默认值优先于通用 Skill 默认值，不静默降档。

## 五、输入与输出规范

- `--input` **必须使用当前操作系统的绝对路径**；Windows 使用当前系统的盘符绝对路径等有效格式，macOS/Linux 使用以 `/` 开头的路径。
- 多个输入以英文逗号分隔；传入文件夹会递归展开并自动过滤非媒体文件，隐藏文件跳过。
- 含空格的路径必须整体加双引号。
- `--output` 与 `--force` 仅作旧命令兼容，**传入会被忽略**，不要在示例或给用户的命令里使用。
- 加 `--json` 后，结构化汇总走 stdout，过程日志走 stderr。

### 结果交付与链接时效

- **CLI 不再自动下载结果文件**。处理成功后，把每个成功文件的 `result_url` 展示为“查看优化后素材”超链接，由用户自行下载，不要尝试在本地落盘。
- **下载链接约 3 小时过期**，交付时必须提醒用户尽快下载。
- 任务提交后到过期前，用户都可以在 [查看最近任务](https://wink.cn/editor/recent-task) 查看已提交的任务并获取结果；**任务 7 天后过期**，到期后无法取回。
- 交付时使用下文“WorkBuddy 链接展示”的统一模板，结果标题为“查看优化后素材”，任务入口标题为“查看最近任务”。
- **任务投递完成时**（上传成功、进入处理排队后）即可提示用户：可随时到 [查看最近任务](https://wink.cn/editor/recent-task) 查看任务进度。

`--json` 输出结构：

```json
{
  "ok": true,
  "command": "picture_quality",
  "env": "release",
  "level": 2,
  "level_name": "超清",
  "total": 1,
  "succeeded": 1,
  "failed": 0,
  "results": [
    {
      "file": "/abs/in/photo.jpg",
      "ok": true,
      "level": 2,
      "level_name": "超清",
      "type": "12",
      "content_type": "1",
      "result_url": "https://..."
    }
  ]
}
```

单文件失败时该项为 `{ "file": "...", "ok": false, "reason": "...", "task_id": "...", "error_code": "..." }`，其余文件继续处理。

## 六、退出码与失败恢复

| 退出码 | 含义 | 应对 |
|---|---|---|
| 0 | 全部成功 | 正常交付 |
| 1 | 参数、登录、配置或初始化失败 | 按 stderr 原文定位；结合实际提交阶段和任务 ID 判断是否已投递，不仅凭退出码断言没有消耗 |
| 2 | 部分任务失败 | 逐条看 `results` 中 `ok:false` 的 `reason`，只重试失败项 |
| 3 | 全部任务失败 | 如实告知失败原因，不要连续重试 |

失败处理原则：

- 服务端明确拒绝（如档位不支持当前环境、媒体超限）时**直接如实转述服务端提示，不重试**——重试可能重复消耗额度。
- **美豆不足**时 CLI 会自动打开充值页并每 5 秒轮询余额（最长等 300 秒），充值到账后**自动继续投递**。此时告知用户「已打开充值页面，充值到账后任务会自动继续」，**不要中断进程、不要重新执行命令**；仅当等待超时才按失败处理，提示用户充值后重新运行。
- 网络中断或轮询超时的日志会保留 `task_id`。此时**不要重新投递**，引导用户到 [查看最近任务](https://wink.cn/editor/recent-task) 查看该任务的实际状态。
- 参数类错误（未知选项、档位越界、路径不是绝对路径、缺失必填参数）属于本地校验失败，未上传任何文件，修正后可安全重跑。
- 报告失败时保留简短的原始错误摘要便于定位，不要循环重试。

## 七、高风险操作的确认规则

云处理会消耗用户账户额度，属于**付费且不可撤销**的操作。因此：

1. 提交前明确**命令、档位与目标文件数量**。用户已明确授权当前范围时直接继续，不重复索要同一项确认；范围或收费操作未获授权时先确认。
2. 批量文件（尤其整个文件夹递归展开出的多文件批次）必须先报告文件数量，确认后再投递。
3. 用户诉求模糊、或需要猜测档位时，先问清楚再提交，不要用默认档位"先跑一版看看"。
4. 同一素材不要因为结果不满意就反复重投；先确认档位选择是否合适。

## 八、调用示例

```bash
# 单张图片画质修复（超清档）
wink-cli picture_quality --level 2 --input "/abs/path/photo.jpg" --json

# 视频超分到 4K
wink-cli resolution_repair --sr-mode 3 --input "/abs/path/video.mp4" --json

# 老照片修复并超分
wink-cli old_photo --variant quality --input "/abs/path/old.jpg" --json

# 去水印（AI 去水印档）
wink-cli remove_watermark --level 2 --input "/abs/path/marked.jpg" --json

# 批量：整个文件夹递归处理
wink-cli denoise --strength median --input "/abs/path/folder" --json

# 查帮助（档位表与专属参数）
wink-cli picture_quality --help
```

## 九、边界

- 本 CLI 只做图片与视频的云端处理，**不修图内文字**、不做通用图像编辑、不提供额度查询。
- 只使用本说明列出的命令与参数。不要自行拼接内部接口、构造 `right_detail`、`type_params` 等协议字段，也不要绕过 CLI 直连服务端。
- 命令返回的帮助文案与本文若有出入，**以 `wink-cli <命令> --help` 的实时输出为准**。

## 十、排障参考

命令报错但原因不明时，运行 `wink-connector skill --reference http-api`（Windows 可用 `wink-connector.cmd`），读取与当前 CLI 同版本的排障参考。源码位于 `references/http-api.md`。

参考说明授权、能力配置、风格列表、投递和轮询的实际协议边界；日常一律走 CLI，不凭旧接口示例绕过本地校验。

## 去水印结果交付（CLI 1.11.1 起）

以 JSON `results[].ok` 判断各素材状态，只交付成功项的 `result_url`。未检测到水印、算法失败、结果链接缺失时报告真实原因，不把响应或进度中的原素材 URL 当作成功结果。混合批次分别说明成功和失败。当前版本已包含此修复；升级不能改变上述成功判定。

## WorkBuddy 链接展示

- 面向用户的网页链接使用可点击的 Markdown 超链接，放在正常正文、列表或表格中；不要输出裸网址、用网址作标题，或把实际交付链接放进代码块/反引号。
- 只对 `results[]` 中 `ok === true` 且具有有效 HTTP(S) `result_url` 的成功项展示 `[查看优化后素材](<RESULT_URL>)`。将 `RESULT_URL` 替换为该项真实完整地址，保留全部查询参数和签名；不缩短、重拼或替换成原素材/封面地址，不把占位符交给用户。
- 最近任务入口统一展示为 [查看最近任务](https://wink.cn/editor/recent-task)。任务提交后、结果交付时或已有任务的轮询中断时可提供；这个入口本身不代表任务已成功，也不承诺该账号一定能查到本次任务。
- 单文件按“原文件名 · 已完成 · 查看优化后素材”的形式交付，其中“查看优化后素材”必须是上述超链接。批量逐项列出文件名、真实状态及对应结果超链接；最近任务入口在列表后统一提供一次。
- 失败、未检测到水印、结果缺失或尚未提交时不展示“查看优化后素材”，只说明真实原因和已有任务标识；混合批次只为成功项生成结果超链接，不因展示规则改变能力限制或成功判定。
- 其他面向用户的业务链接也使用语义标题，例如“访问 Wink 官网”“前往授权”“购买美豆”；授权和购买地址仅使用工具实际提供的完整地址，不编造链接，不展示内部 API 或调试地址。

回复排版示例（仅示意；真实回复用实际结果替换 `RESULT_URL`，不要保留代码块）：

```markdown
素材.mp4 · 已完成 · [查看优化后素材](<RESULT_URL>)

[查看最近任务](https://wink.cn/editor/recent-task)
```
