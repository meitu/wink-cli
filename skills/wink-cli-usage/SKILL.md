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

本说明由当前安装的 wink-cli 随包提供，可供 WorkBuddy 的「Wink」连接器以及其他 Agent 调用。通过 `wink-cli skill` 读取时，Skill 版本自动取自 CLI 的 package.json，与 CLI 一起升级。每次新任务先读取当前文档；CLI 更新后重新读取，不沿用旧会话中的参数表。Windows 可使用 `wink-cli.cmd skill`。

CLI 可以独立安装并完成授权登录；WorkBuddy 也可通过连接器安装与认证。本文说明命令与档位选择、参数、结果判定和失败处理。CLI 帮助是实际支持参数的最终依据。

默认使用简体中文；用户明确指定其他语言时跟随用户。

## 一、前置：先做一次环境自检

业务命令执行前，先确认运行时与登录态：

```bash
wink-cli doctor --json
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

同时确认 `wink-cli --version` 与正在读取的 Skill 所属 CLI 版本一致。命令不存在、版本低于 1.14.0 或连接器安装失败导致 CLI 不可用时，运行一次 `npx --yes --userconfig=/dev/null meitu-wink-cli@1.14.3 install`（Windows 可用 `npx.cmd`），等待安装完成后重新核验。WorkBuddy 市场搜不到 Wink 时也使用此兜底；已有可用 CLI 时直接复用，不要求先连接市场条目。

安装需要 Node.js 18+、npm 和 Git。依赖缺失、网络或安装失败时报告真实错误和“尚未提交”，不循环安装。若 PATH 仍命中旧版本，用 `npm --userconfig=/dev/null root -g` 找到当前 npm 的全局包目录，以 `node "<全局包目录>/wink-cli/src/cli.js" ...` 使用同一安装包；核验版本并重新读取本说明，不使用临时 npx 缓存路径。独立业务 Skill 的功能、档位和用户选择不因安装兜底改变；不要绕过 CLI 直连接口。

## 二、认证前置条件

自动打开授权页（CLI 1.14.0+）：直接运行 `wink-cli login --open-browser`，Windows 使用 `wink-cli.cmd login --open-browser`。此选项由命令自身打开系统浏览器，后台运行或输出被管道接收也不会跳过；WorkBuddy 连接器面板的 auth 仍由面板托管，不加此选项以免重复打开。启动时使用持续进程／会话句柄，约 1–2 秒即读取原始输出；短等待不能杀掉进程。禁止接 `| tail -5` 等等待 EOF 的管道或用同步命令替换提取链接；仅支持后台执行时，将输出写入本次独立日志并及时读取，保留确切进程标识。展示本次真实完整链接为“前往授权”备用超链接，命令已经尝试打开时不再另开页面；仅在明确打开失败或用户反馈未打开时，用同一链接补开一次。CLI 内置 300 秒轮询时限（网络请求可能延后实际退出），宿主总超时可留到 360 秒。不得猜测 once_code 只有 60 秒有效，也不能仅凭“尚未授权或已过期”的合并错误判定已过期；继续等待同一进程，只有实际超时、进程失败退出或用户要求重新登录时才重新发起。禁止用 `pkill -f` 批量终止登录进程。浏览器失败时保留链接与原进程让用户手动授权；打开成功不等于登录成功，外部终止也不等于服务端拒绝。

- 凭据由连接器与 CLI 共同管理，落盘在 `~/.wink-mcp-server/cli-credentials/`，**不要读取、回显或转述其中内容**。
- 未登录时执行 `wink-cli login --open-browser`（Windows 使用 `.cmd`；已解析绝对入口则沿用该入口）；连接器面板可用时也可由面板授权。将实际授权链接显示为“前往授权”超链接，保持同一进程等待成功或超时，不重复启动。`wink-cli status` 的 `WINK_AUTH=connected` 仅说明本地有凭据，退出码 0 不代表已登录。授权成功后沿用本轮素材与参数继续处理，无需重新上传。业务命令首次发现未登录也会自动进入授权等待。凭据明确失效时可使用 `--relogin` 完成一次重新授权；应用或环境权限问题按真实错误处理，不反复登录。
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

视频全能修复调用 `wink-cli video_repair --input "/绝对路径/video.mp4" --json`。首次使用先检查 `wink-cli video_repair --help`；旧 CLI 不支持时需先发布并安装 1.11.0 或更高版本，不改用 `picture_quality --level 11/12`。统一命令入口要求 CLI 1.14.0 或更高版本；新连接器上线前须先发布依赖的 CLI。

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
- 投递渠道 `client_channel_id` 由 CLI 按 Agent 环境自动推断（WorkBuddy 专家 / Skill → `workbuddy`；Cursor / Claude / Codex → 对应值；普通终端 → `cli`）。一般不必手写；仅在排障或明确要求时用 `--channel-id` 或环境变量 `WINK_TASK_CHANNEL_ID` 覆盖。
- 机型 `client_model` 仅在投递时由 CLI 自动采集并携带（如 macOS `Apple M4`）；列表/查询等接口不传。一般不必手写，可用 `--client-model` 或 `WINK_TASK_CLIENT_MODEL` 覆盖。
- **Cursor 进度展示**：直接运行 `wink-cli <命令> ... --json --progress-json`，保留命令会话并增量读取 stderr。也可用 `node "<meitu-wink-cli>/src/agent_run_progress.js" --live-progress <命令> <参数...>` 将进度转为纯文字。上传展示实际 `upload_percent`；处理展示实际 `message`（如“正在处理，预计还需 62 秒”）；阶段切换或数值明显变化时更新用户可见进度，不每秒刷聊天。不要套用 WorkBuddy 的 `--until-done` 静默等待，也不要将两路输出全部重定向后只看最终结果。只读取 `type=progress` 作为进度，`type=diagnostic` 为排障日志。成功后立即交付，不自行倒计时或猜测正在加水印。
- **宿主判定**：以下 WorkBuddy 专用规则只在 WorkBuddy 内使用；CLI 位于 `.workbuddy` 安装目录不代表当前宿主就是 WorkBuddy。
- **WorkBuddy 可见文字进度与结果交付（必做）**：这里的文字进度是时间线上的 Bash `description`，不是等待工具内被折叠的 stdout。每条到期进度通过下一次等待调用的标题展示，不用代码块、固定 sleep 或 TaskUpdate。
  1. 上传前提示后，用 Bash `run_in_background: true` 启动默认进度包装脚本，`description` 仅一次设为 `正在准备上传素材`。本轮先确定一个唯一日志绝对路径，后续调用沿用同一路径，不能依赖跨 Bash 共享变量：
     ```bash
     node "$HOME/.workbuddy/binaries/node/cli-connector-packages/lib/node_modules/meitu-wink-cli/src/agent_run_progress.js" --log "<本次日志绝对路径>" <命令> <业务参数...>
     ```
     `--log` 自动创建父目录并统一写入日志和 `<日志路径>.stdout`，不要再加 shell 重定向；每次使用未使用过的新日志路径，已有路径会拒绝启动。启动失败时先检查原后台任务，不继续空等 watch，也不自动重投。不用 `--live-progress`，不要 shell `&`。上传按实际百分比跨 20% 档位输出，100% 上传成功后单独输出。
  2. 立即前台调用普通 watch，Bash `timeout: 3900000`（须覆盖 CLI 单任务默认轮询 3600 秒，并留约 5 分钟余量），首次 `description` 为 `正在上传素材`：
     ```bash
     node "$HOME/.workbuddy/binaries/node/cli-connector-packages/lib/node_modules/meitu-wink-cli/src/agent_watch_log.js" --compact "<本次日志绝对路径>" "<上一条完整进度，首次为空字符串>"
     ```
     WorkBuddy 不使用 `--until-done` 或 `--stream-progress` 来替代这个循环，它们不会更新截图中的可见标题。普通 watch 在下一条已节流进度或完整结果出现时才返回，内部每 100ms 检查结果，没有固定睡眠等待。
  3. 若返回普通进度行，立即再调用同一 watch，将该行完整传作上一条进度，同时将 Bash `description` 设为该行，例如 `11.2s clip.mp4 · 上传中 79%` 或 `50.0s clip.mp4 · 正在处理，预计还需 550 秒`。不要只在聊天里解释，也不要额外读目录、JSON 或记忆。每次只展示最新状态，不回放漏过的旧进度；快速任务可能跳过部分中间百分比。若宿主将单次等待转后台，继续读取其原任务句柄，禁止重复投递。
  4. 处理频次由脚本按每个文件的首次有效剩余预估 R 秒固定：R/10 < 10 秒时只显示一次真实剩余秒数；10 ≤ R/10 ≤ 50 时按 R/10 秒间隔；R/10 > 50 时按 50 秒间隔。预估 11 秒显示 1 次，200 秒约 10 次，600 秒约 12 次。首次预估立即显示并计入次数；未知预估只显示“正在估算剩余时间”，收到有效预估再定频。实际提前完成就提前结束；进入“已超过预计时间”后按 50 秒间隔继续刷新标题，仍持续等待直至 `__DONE__`；不编造倒计时、处理百分比或加水印阶段。标题更新还受宿主模型耗时影响，不承诺精确条数。
  5. 返回 `__DONE__` 表示整批结束：立即把 `__DELIVER__` 到 `__END_DELIVER__` 中的 Markdown 原样回复，保留失败项，不先写记忆、重读 `--json` stdout 或调用文件展示。compact 模式不附带 `__JSON__`，交付以 `__DELIVER__` 为准。成功检查优先于进度，完成不等待 10–50 秒的显示间隔。返回 `__ERROR__` 时如实报告并核查原任务，不自动重新收费投递。见到充值提示按原充值规则及时告知。模型在两次工具调用间仍会有耗时，这与服务端处理耗时分开衡量。
- **`--list-styles` 等查询命令例外**：`ai_beauty --list-styles`（以及 `doctor`、`--help` 等不上传、不投递的查询）直接前台运行 `wink-cli ... --json`，不要套 `agent_run_progress.js` / `agent_watch_log.js`；其 stdout 是 `{ styles }` 等查询结构，不是带 `total`/`results[]` 的批处理汇总，走 watch 会被误判为 `__ERROR__`。仅真正投递云处理任务时才用进度包装与 watch 循环。
- **素材上传之前**提示文案（同一批次只一次；不要等 `task_id` 或上传中再发；不要编造“任务提交成功”）：

  批量任务、较长视频或较大文件通常需要更多处理时间。任务会在云端持续处理，你可以前往【[查看最近任务](https://wink.cn/editor/recent-task)】查看最新进度，或等待全部完成后通知你。

- 本地终端仍可用 `--progress-json` 看同行进度；WorkBuddy 必须走 `agent_run_progress.js`，并用 `run_in_background: true`（不要 shell `&`）。
- 进度事件字段：`file`、`phase`（`uploading` / `processing` / `waiting_recharge` / `completed` / `failed`）、`task_id`、`elapsed_ms`、`remaining_ms`、`upload_percent`、`result_url`、`message`。上传 `message` 形如 `上传中 N%`；处理为“正在处理，预计还需 X 秒”／“正在估算剩余时间”／“已超过预计时间 N 秒，当前任务可能比较多，请您耐心等待”。
- 收到 `waiting_recharge` 时立即按充值规则在聊天提示；只在最终成功时交付。检查退出码和最终汇总。
- 发出上传前提示后继续等待原命令结束再汇总；不要发完提示就结束等待，不重复投递。进程中断或超时时如实说明并提供最近任务链接。

### 结果交付与链接时效

- **CLI 不再自动下载结果文件**。处理成功后，把每个成功文件的 `result_url` 展示为“查看优化后素材”超链接，由用户自行下载，不要尝试在本地落盘。
- **下载链接约 3 小时过期**，交付时必须提醒用户尽快下载。
- 任务提交后到过期前，用户都可以在 [查看最近任务](https://wink.cn/editor/recent-task) 查看已提交的任务并获取结果；**任务 7 天后过期**，到期后无法取回。
- 交付时使用下文“WorkBuddy 链接展示”的统一模板，结果标题为“查看优化后素材”，任务入口标题为“查看最近任务”。

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
- **美豆不足**时，立即按下文“美豆不足时的即时提示与购买链接”告知用户，并保持原 CLI 进程等待；余额增加后由 CLI 重试，失败与超时如实报告。
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

命令报错但原因不明时，运行 `wink-cli skill --reference http-api`（Windows 可用 `wink-cli.cmd`），读取与当前 CLI 同版本的排障参考。源码位于 `references/http-api.md`。

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

安装与 npm 路径查询使用空的用户配置，避免 npm 自动读取含令牌的 `~/.npmrc`：上述 `--userconfig=/dev/null` 适用于 macOS/Linux；Windows 使用 `npx.cmd --yes --userconfig=NUL meitu-wink-cli@1.14.3 install` 和 `npm.cmd --userconfig=NUL root -g`。保留这些参数，不读取或打印 `.npmrc`、完整环境变量或 npm 配置，不要求用户提供 npm Token，也不关闭 Agent 的凭据保护。若自定义镜像、代理或安装目录因隔离用户配置而不可用，报告实际错误，可由用户明确指定非敏感配置，不恢复读取凭据文件。

## 美豆不足时的即时提示与购买链接

- 仅当本次 CLI 实际返回美豆不足／进入“等待充值”时，立即在当前会话告知用户，不等余额轮询结束才回复，也不把等待充值描述成正在云处理。使用以下文案，并把本次 CLI 输出的完整购买地址展示为“购买美豆”Markdown 超链接：

  美豆不足，已为你准备了限时特惠，请在Wink购买使用。

  [购买美豆](<CLI_PAYMENT_URL>)

  CLI 正在等待充值，检测到美豆余额增加后会自动重试提交，无需重复发送素材。

- `CLI_PAYMENT_URL` 必须替换为本次 CLI 日志中的真实购买链接；不要向用户输出占位符、裸网址或代码块。核对环境：release 为 `https://wink.cn/workspace?showPayment=1`，beta 为 `https://beta.wink.cn/workspace?showPayment=1`，pre 为 `https://pre.wink.cn/workspace?showPayment=1`；保留实际地址的查询参数，不将 pre/beta 用户引到 release。未取得实际链接时先读取同一进程输出，不猜测支付地址。
- CLI 已主动尝试打开购买页时，不再重复打开；明确打开失败或用户反馈未打开时，通过宿主的打开网页能力／系统浏览器补开同一个真实链接一次，不要求用户先手动点击。无可用浏览器或打开失败时如实说明，仍保留可点击链接；没有打开成功的证据时，不声称“已打开”。购买和付款由用户自行完成；上述为固定引导文案，具体优惠、资格、金额和有效期以购买页为准，不额外编造折扣或承诺优惠到账。
- 执行业务命令时保留持续进程／会话句柄，启动后及时读取 stdout 和 stderr，此后用短等待增量读取。禁止 `| tail`、等待 EOF 的输出捕获或一次阻塞到整个任务结束，避免隐藏充值提示。后台执行时及时读取该进程的日志，不等命令退出才读；`--json` 的最终 stdout 可能尚未输出，应同时读取 stderr。
- 显示提示后继续等待原 CLI 进程，每 5 秒的余额查询和最长 300 秒等待由 CLI 负责；不要另开余额轮询、重启命令、重复投递或要求用户回复“已充值”才能继续。无需每 5 秒重复发送购买文案；余额增加仅代表可重试，不保证足够，最终提交是否成功以服务端为准。再次不足时沿用 CLI 的剩余等待时间。
- 基准余额获取失败、进程退出或等待超时时，按实际日志说明当前阶段，提供真实购买链接，但不再说“正在等待／充值后自动继续”。已有 task_id 时保留供核查；只有真实成功且有有效结果链接才交付“查看优化后素材”。此规则不放宽专家能力边界，也不允许尚未接入的能力发起任务。

### WorkBuddy 画质修复埋点

仅在 WorkBuddy 执行 `picture_quality` 时，业务参数同时带 `--channel-id workbuddy --tracking-prompt <本次用户处理要求>`。提示词只取本次任务要求，先剔除凭据、联系方式、素材路径和链接；以当前 shell 的安全参数引用方式传入，不拼接成可执行脚本，不附带历史对话或素材内容。CLI 会再次基础脱敏，通过后台进程上报。没有可用任务要求时省略该参数，不编造提示词。其他宿主或其他专家不标记为 WorkBuddy 高清修复师。无需额外调用埋点接口，也不要等待埋点后才交付结果。`WINK_TELEMETRY=0` 可关闭此 MVP 埋点。
