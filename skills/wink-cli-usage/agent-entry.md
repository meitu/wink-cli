---
name: wink-cli-usage
description: 使用 Wink CLI 处理图片或视频，支持功能编号选择和用户自定义多步顺序；每次先读取当前 CLI 的完整说明与真实参数。
---

# Wink 图片视频全能处理

每次新的云处理任务，先执行下面的只读命令并阅读完整输出。命令使用本次安装的 Node.js 和 CLI 绝对路径，避免误用 PATH 中的旧版本。

```{{SHELL}}
{{READ_COMMAND}}
```

完整使用说明随 CLI 发布；CLI 升级后重新读取，不沿用旧会话里的参数表。此命令不登录、不联网、不上传素材，也不消耗美豆。需要结构化内容与版本信息时，在命令末尾加 `--json` 并阅读 `content`。

实际处理时按完整说明展示固定编号菜单，允许用户单选或指定有序功能链；已明确的目标和顺序直接沿用，不自动重排、增加或去重。专家已有菜单与开放范围时遵循专家配置。多步链中，上一步唯一匹配的成功结果必须先通过CLI 安装包内的 `skills/wink-cli-usage/scripts/download_intermediate.cjs` 下载为新的本地输入，才能运行下一步；失败或状态未知时停止依赖步骤，不重复投递。中间步骤按完整说明读取汇总并衔接，最终结果仍交付链接。安装 / 状态检查不提前登录、上传或创建任务。

按返回的说明检查环境、登录状态、功能与档位，再执行用户授权的处理。若业务命令 `wink-cli --version` 与读取的 CLI 版本不一致，先修正 PATH 或使用该安装目录中的 CLI。不要用旧版业务命令配合新版说明。

命令不存在、退出失败或正文缺失时，停止业务投递并说明需要重新运行 `npx --yes --userconfig=/dev/null meitu-wink-cli@1.14.13 install` 修复安装；不要凭记忆猜测参数。排障时可在上述读取命令末尾加 `--reference http-api` 获取同版本参考。

登录由 CLI 的正常流程处理；WorkBuddy 中也可通过连接器完成授权。读取 Skill 不代表用户已授权收费处理。只交付 CLI 判定成功的真实结果链接，显示为“查看优化后素材”，最近任务入口显示为“查看最近任务”。不要回显凭据或将原素材链接作为成功结果。

按当前宿主选择进度方式，不因 CLI 安装在 `.workbuddy` 目录就判定正在使用 WorkBuddy：

- **Cursor（以及支持增量读取命令输出的宿主）**：直接运行业务命令并加 `--json --progress-json`；需要纯文字进度时用 `agent_run_progress.js --live-progress <业务参数>`。保留进程句柄，持续增量读取 stderr；向用户展示最新“上传中 N%”“正在处理，预计还需 X 秒”，阶段变化或进度明显变化时更新，成功后立即交付。不要使用 `--until-done` 隐藏中间进度，不要把 stdout/stderr 全部重定向后只等最终 JSON。
- **仅 WorkBuddy**：要显示时间线上的上传百分比、剩余秒数，使用 `agent_run_progress.js --log <本次独立日志绝对路径>`（不加 `--live-progress`）后台启动；脚本自动创建日志目录和 `<日志路径>.stdout`，不要额外 shell 重定向，已有路径会拒绝启动；前台循环 `agent_watch_log.js --compact <日志路径> <上一条完整进度>`，不加 `--until-done` / `--stream-progress`。每次 Bash 等待 `timeout: 3900000`（覆盖 CLI 默认 3600 秒轮询）。首次等待标题为“正在上传素材”；每次返回进度后，立刻以该行作为下一次 Bash `description` 和上一条进度参数。脚本按首次有效 R 定频：R/10 < 10 秒只显示一次；10–50 秒按 R/10；超过 50 秒封顶 50 秒（11 秒一次，600 秒约 12 次）；进入“已超过预计时间”后按 50 秒继续刷新。返回 `__DONE__` 后直接交付 `__DELIVER__`，保留失败项，不重读 `--json` stdout；`__ERROR__` 如实报告，不重复投递。`--list-styles` 等查询直接跑 `wink-cli ... --json`，不走进度包装。工具标题更新需要模型轮次，但完成检查不等待进度间隔。详细命令见完整说明。

进度只采用 CLI 实际返回值，不自行倒计时或推算处理百分比。接口尚未给出具体阶段时，不猜测为“加水印中”。

安装与 npm 路径查询使用空的用户配置，避免 npm 自动读取含令牌的 `~/.npmrc`：上述 `--userconfig=/dev/null` 适用于 macOS/Linux；Windows 使用 `npx.cmd --yes --userconfig=NUL meitu-wink-cli@1.14.13 install` 和 `npm.cmd --userconfig=NUL root -g`。保留这些参数，不读取或打印 `.npmrc`、完整环境变量或 npm 配置，不要求用户提供 npm Token，也不关闭 Agent 的凭据保护。若自定义镜像、代理或安装目录因隔离用户配置而不可用，报告实际错误，可由用户明确指定非敏感配置，不恢复读取凭据文件。

调用来源埋点：每次 CLI 调用（含 help/version、登录和业务命令）同时传 `--expert-id "<入口原始ID>" --source-name "<入口完整中文展示名称>" --source-type <expert或skill>`，或仅在本次子进程设置 `WINK_EXPERT_ID`、`WINK_SOURCE_NAME`、`WINK_SOURCE_TYPE`。专家使用原始专家包 ID 和完整中文职称，source_type 固定为 expert；独立 Skill 使用原始 Skill ID 和完整中文展示名称，source_type 固定为 skill。expert_id 不添加类型前缀。专家调用内嵌 Skill、入口 Skill 调用下级 Skill 时整组沿用入口的三个值，不替换成下级来源；独立使用本说明 Skill 时使用 wink-cli-usage / Wink 图片视频全能处理 / skill。无来源上下文时不编造，缺省为 null；明确参数优先于对应环境变量，不持久化全局环境。进度包装脚本原样转发三个参数。

公共问题反馈：先读取同版本完整 Skill 的“静默反馈”章节。仅符合该章节的高影响公共问题时，沿用原任务环境和凭据，使用 CLI feedback --silent；无现有凭据时跳过，不额外登录，不在交付中提示，不代替原任务失败说明。不得直接 curl 反馈接口或跨环境投递。

反馈候选场景包括安装包缺失、能力配置与参数不一致、授权链路缺陷、任务状态矛盾、批量错配、多步衔接错误、进度阻断交付、隐私安全缺陷及有证据的重复投递/异常计费。按完整 Skill 逐项核实，不为复现新增收费任务，不凭报错推断扣费；没有有效凭据时保留脱敏诊断并跳过。
