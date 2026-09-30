# Wink CLI

用于图片和视频云处理的命令行工具。支持授权登录、本地媒体校验、上传、任务投递、轮询及结果链接输出。

## 安装和运行

当前 npm 安装入口（已发布的 1.14.3）：

```sh
npx --yes meitu-wink-cli@1.14.3 install
wink-cli --help
```

需要先安装 Node.js（建议使用受支持的 LTS 版本）和 npm，并能访问 npm 源，不需要 Git。npm 包名为 `meitu-wink-cli`，命令仍为 `wink-cli`。此命令将指定版本安装到 npm 全局目录并同步 Agent Skill，不依赖 npx 缓存长期保留，不触发登录或云处理。升级时将安装命令中的版本号改为已验证的新版本。首次使用前须先将对应版本发布到 npm；Git 推送不等于 npm 发布。

若全局目录没有写入权限，可使用 `npx --yes meitu-wink-cli@1.14.3 install --prefix <可写目录>`。macOS/Linux 将 `<可写目录>/bin` 加入 PATH，Windows 将 `<可写目录>` 加入用户 Path，再重新打开终端。安装后使用 `wink-cli`；旧的 `wink` 命令不再由本包注册。

npm 安装的发行包卸载使用 `npm uninstall -g meitu-wink-cli`；GitHub 安装的兼容包使用 `npm uninstall -g wink-cli`；自定义安装前缀时追加相同的 `--prefix <目录>`。安装帮助：`wink-cli install --help`。

如果此前安装过旧包 `wink-cli-v2`，请先运行 `npm uninstall -g wink-cli-v2`，再执行上面的安装命令，避免旧包占用同名命令。使用自定义 `--prefix` 时，卸载也需要指定相同前缀。

### GitHub 旧安装器兼容与 npm 发布

从 1.14.2 起，两种发行方式共用同一份业务代码，但保留各自的安装契约：

| 来源 | 包名 | 全局包目录 |
|---|---|---|
| GitHub 仓库／旧专家克隆安装 | `wink-cli`（private） | `node_modules/wink-cli` |
| npm 公开发行包 | `meitu-wink-cli` | `node_modules/meitu-wink-cli` |

已上架的旧专家安装脚本会校验根包名和安装目录为 `wink-cli`，因此不要再次修改 Git 根包名。修复推送到 GitHub 默认分支后，原来的旧脚本重新克隆即可使用，不要求先更新专家或 Skill。此兼容修复解决包名／目录失败；运行环境仍需要 Git、Node/npm 和到 GitHub、npm 的网络访问。不会自动替换用户已经安装的 CLI，也不会修复 GitHub 无法访问的网络环境。

npm 上的 `wink-cli` 属于其他发布者，本仓库以 `private: true` 和发布检查阻止误发。发布公开包时**不要**改仓库根 `package.json` 的包名；在临时目录中改名为 `meitu-wink-cli` 再打包发布：

```sh
# 推荐：测试 → 临时改名打包 → 发布（根 package.json 始终保持 wink-cli）
npm run publish:npm

# 仅演练，不上传
npm run publish:npm -- --dry-run

# 已有 dist 包时跳过测试与打包
npm run publish:npm -- --skip-tests --skip-pack --yes
```

也可分步：`npm run pack:npm` 后执行 `npm publish ./dist/meitu-wink-cli-<version>.tgz --access public --registry=https://registry.npmjs.org/`。`pack:npm` / `publish:npm` 都不修改仓库根 `package.json`；临时打包目录中才将包名设为 `meitu-wink-cli`，去除 private 和仓库开发脚本。不要在根目录直接执行 `npm publish`。

两种安装器之间切换时，仅迁移由 Wink 自身包管理的命令入口，保留已有包文件和登录凭据；安装失败时恢复旧入口。npm 源与 Git 默认分支是独立发布渠道：本次恢复旧专家安装只需将 Git 修复推送到旧脚本克隆的默认分支；发布 npm 本身不会修复 Git 根包名。

可运行 `npm run test:legacy-install` 做联网隔离安装测试：直接使用未修改的历史安装脚本，通过 Git URL 映射克隆当前源码的临时仓库，验证真实依赖安装、旧目录、Git/npm 双向切换与命令入口，不读取真实登录、不执行云任务。历史脚本来自 wink-agents 的 `65b6b40:workbuddy/scripts/install_cli_from_git.cjs`，保存在 `tests/fixtures/legacy_workbuddy_install.cjs`，不得将其改成新版脚本来让测试通过。

### 从源码运行

需要 Node.js 18 或以上。在项目目录运行：

```sh
npm install
./wink-cli --help
./wink-cli picture_quality --level 2 --env pre --input "/absolute/path/video.mp4"
```

Windows 使用：

```powershell
.\wink-cli.cmd --help
.\wink-cli.cmd picture_quality --level 2 --env pre --input "D:\video.mp4"
```

也可以使用 `npm start -- --help`，或通过 `npm install -g .` 安装全局 `wink-cli` 命令。

ffprobe 为可选依赖。图片、常见 MP4/MOV 优先直接读取元信息；解析失败时尝试 ffprobe。未安装 ffprobe 时仍可上传、投递，由服务端探测缺失的元信息。

## 功能命令

| 命令 | 功能 |
|---|---|
| `picture_quality` | 画质修复 |
| `video_repair` | 视频全能修复（Pro 单档） |
| `resolution_repair` | 分辨率修复 |
| `remove_watermark` | 消除水印 |
| `denoise` | 降噪 |
| `color_enhance` | 色彩增强 |
| `color_unite` | 色调统一 |
| `cartoon` | AI动漫 |
| `night_scene` | 夜景提升 |
| `video_frame` | 视频补帧 |
| `ai_translation` | AI翻译 |
| `ai_beauty` | AI美容 |
| `video_defogging` | 视频去雾 |
| `old_photo` | 老照片修复 |

单档位功能可省略 `--level`。档位、媒体限制及专属参数通过 `wink-cli <命令> --help` 查看。

自 1.11.1 起，去水印接口即使返回 `error_code=0`，未检测到水印仍按失败返回，不交付成功链接；新协议缺少算法结果链接时也不再回退到原素材地址。Skill 应逐项检查 `results[].ok`，只交付成功项的 `result_url`。

视频全能修复自 1.11.0 起使用 `wink-cli video_repair --input "/absolute/path/video.mp4" --json`。按官网 Pro 功能标识从服务端配置选择算法，默认开启抖动检测，每个视频投递一个任务；不将专业级画质修复或 AIGC 精修代作全能修复，也不自动裁短超时视频。

```sh
./wink-cli denoise --env pre --input "/absolute/path/photo.jpg"
./wink-cli ai_translation --env pre --input "/absolute/path/video.mp4" --target-language en
```

## AI 美容风格与附加效果

可通过性别偏好随机选择适用风格，或者查询当前环境下的风格，再将返回的 `material_id` 传给 `--style`：

```sh
wink-cli ai_beauty -gender male --input "/absolute/video.mp4"
wink-cli ai_beauty --gender female --input "/absolute/photo.jpg"
wink-cli ai_beauty --list-styles
wink-cli ai_beauty --list-styles --json
wink-cli ai_beauty --style <物料ID> --input "/absolute/video.mp4"
wink-cli ai_beauty --style <物料ID> --hair-silky --beauty-double-chin --input "/absolute/photo.jpg"
wink-cli ai_beauty --hair-silky --input "/absolute/video.mp4"
```

`-gender` 和 `--gender` 等价，值为 `male` / `female`，与 `--style` 二选一。CLI 获取完整列表后，按风格名称匹配：`male` 对应“少年、绅士、硬朗、浪漫”，`female` 对应“自然、减龄、裸感、女高、浓颜、欧美、紧致”；名称中明确的“男/女、male/female”标记优先。排除当前媒体不适用或配置无效的素材后，从全部匹配候选中等概率随机选一个（CLI 1.12.1 起）；每个输入文件独立选择，混合图片/视频会分别筛选。名称同时对应男女两类的素材不参与匹配；没有适用候选时，在上传前失败并提示通过 `--style` 手选。同一任务因美豆不足而重试投递时沿用已选素材，不重新抽取。`gender` 只用于本地选风格，不额外传到投递接口；`--json` 的每项成功结果包含实际 `beauty_style` 的物料 ID、名称与所选性别。

CLI 不推断性别偏好；需要显式指定 `--gender`、`--style` 或至少开启一个附加效果才可处理。发质柔顺、去双下巴默认关闭，两个开关可以单独使用，也能与 `--gender` 或 `--style` 组合。CLI 每次处理前获取完整风格列表，验证物料 ID 和图片/视频适用范围，CLI 1.12.2 起优先将服务端的非空对象 `material_conf.beauty_style` 原样作为投递的 `beauty_style`；该字段无有效值时兼容旧文档的非空对象 `material_conf.parameter`。两者均有效时只使用前者，不合并；两者都无效时在上传前拒绝。图片的附加效果使用 `media_mode=0`，视频使用 `1`，关闭的效果不传。旧的 `--retouch-params` 改为上述风格选择方式，不再手写或猜测美容参数。

处理流程：检查命令和输入 → 检查登录凭据，必要时授权登录 → 拉取完整素材列表 → 获取能力配置 → 按当前媒体与 gender 随机选素材，完成媒体及能力校验 → 上传 → 投递 → 轮询 → 返回结果链接。`--style` 仍固定使用指定物料，不参与随机选择。

列表查询使用当前 CLI 环境的 `/material/ai_beauty/list` 与现有 `api_key`；查询不上传素材或投递任务。接口失败时处理流程在上传前停止。2026-09-20 只读核对 release 列表已正常返回 13 个风格，配置位于 `material_conf.beauty_style`；此前 2026-09-18 的 `10108` 是历史观测。当前“浓颜”支持图片/视频，“少年、绅士、浪漫、硬朗”仅支持图片，因此当前目录下 `--gender male` 视频输入仍会提示无适用候选，实际限制以每次接口返回为准。已验证真实列表的本地解析和模拟投递协议，尚未验证真实付费云处理效果。

## 登录、输入和输出

- 默认环境为 `release`，可用 `--env pre|beta|release` 切换。仅 pre 使用测试上传通道。
- 首次运行打开授权页，CLI 轮询本次授权码获取 api_key；`--relogin` 可重新授权。
- 输入使用绝对路径，支持多个文件和文件夹，以英文逗号分隔；文件夹会递归展开。
- 视频时长按当前能力配置检查。CLI 尚未获得可信的会员状态，不再把未知账号按普通用户上限拦截；最小时长和 `input_limit` 等素材限制仍在本地校验，普通/会员上限均有效时也会拦截超过两者最高值的视频。其余账号专属时长限制由投递接口判断；本地检查通过不代表已确认会员权益，服务端拒绝时直接返回原始原因，不自动重投。
- 处理成功后仅显示下载链接，不自动下载、不创建结果目录；`--json` 的每个成功结果通过 `result_url` 返回链接。旧命令中的 `--output` 和 `--force` 继续接受但不再生效。
- 每个文件的上传、处理和完成状态在终端同一行更新；`--json` 输出结构化结果。
- 投递返回 `code=1999` 且 `message` 包含“美豆不足”时，先调用 `/subscribe/remain_amount_info` 记录 `total_amount`，再按 `--env` 打开对应充值页；每 5 秒查询余额，余额大于充值前的记录值后复用已上传文件重新投递，不需要额外命令参数。
- 每个文件的充值等待最多 300 秒。余额不变或减少时继续等待；首次余额获取失败时显示错误，不将未知余额当作 0。重新投递仍提示美豆不足时重新记录基准余额，在剩余时间内等待再次增加，不重复打开充值页。后续投递是否成功由服务端判断。
- 余额请求沿用所选环境的 API 地址及现有 `api_key`；客户端配置了账号 `Access-Token` 时也会携带该请求头。服务端是否支持 CLI 的 `api_key` 鉴权仍需真实接口联调确认。

设备编号 `gnum` 使用十进制正整数（int64）。CLI 优先使用 `WINK_TASK_GNUM`，其次读取本地 `task-gnum`，再尝试迁移旧 SDK `datareport/dataReport.json` 中的有效 `gid`；均不可用时，使用加密随机数生成 `1` 至 `9223372036854775807` 范围内的编号并缓存，后续运行保持不变。全程以字符串传参，避免整数精度丢失。本地生成仅保证格式有效，不等同于服务端发号；服务端是否接受新编号仍需联调确认。

投递渠道 `client_channel_id` 默认按调用 Agent 推断：WorkBuddy（专家 / Skill）为 `workbuddy`，Cursor / Claude Code / Codex 分别为 `cursor` / `claude` / `codex`，普通终端为 `cli`。可用 `--channel-id` 或 `WINK_TASK_CHANNEL_ID` 覆盖。

机型 `client_model` 仅在投递 `/task/submit` 时携带；列表、查询等接口不传。默认自动采集：macOS 优先 CPU 营销名（如 `Apple M4`），Windows 优先 CPU 名（缺失时回退电脑型号），Android / 鸿蒙优先产品型号，iOS 使用宿主提示。可用 `--client-model` 或 `WINK_TASK_CLIENT_MODEL` 覆盖。

### WorkBuddy 实时进度

```bash
wink-cli picture_quality --level 2 --input "/absolute/path/photo.jpg" --json --progress-json
```

保留命令的持续进程句柄，增量读取 stderr，不要等命令结束才读取。`--progress-json` 将文件进度改为一行一个 JSON 事件；stderr 仍可能包含普通诊断文本，按完整行解析，仅消费 `type === "progress"` 的对象。stdout 继续只提供原有最终结果 JSON（使用 `--json` 时）。没有新事件不代表任务停止，相同事件可能去重；处理状态默认约每 1 秒查询一次，另加请求耗时。

```json
{"type":"progress","file":"/absolute/path/photo.jpg","phase":"processing","task_id":"example-task","elapsed_ms":5000,"remaining_ms":3000,"message":"正在处理，预计还需 3 秒"}
```

| 字段 | 含义 |
|---|---|
| `phase` | `uploading`、`processing`、`waiting_recharge`、`completed`、`failed` |
| `file` | 输入文件绝对路径，多文件时按此区分 |
| `task_id` | 提交成功后的任务 ID，此前为 `null` |
| `elapsed_ms` | 从提交成功开始实际经过的毫秒数，含排队和查询等待，不含上传、提交前充值等待；提交前为 `null` |
| `remaining_ms` | 服务端预估剩余毫秒数，缺失或无效为 `null`；完成时为 `0`，失败时为 `null` |
| `upload_percent` | 仅上传阶段提供，确认上传成功才为 `100` |
| `result_url` | 仅完成事件提供，仍以最终结果 JSON 为交付依据 |
| `message` | 展示文案；等待充值时包含充值提示，失败时包含原因 |

上传阶段 `message` 形如 `上传中 N%`，并带 `upload_percent`。云处理阶段显示“正在处理，预计还需 X 秒”，X 为 `Math.ceil(remaining_ms / 1000)`；`remaining_ms === null` 时显示“正在估算剩余时间”。任务仍在处理但预估归零时显示“已超过预计时间 N 秒，当前任务可能比较多，请您耐心等待”，N 为自预估归零起已等待的整秒数，只能依据 `completed` 判定完成。终端进度用人可读的文件名单行刷新；`--progress-json` 的 `file` 仍是完整路径。不要把剩余时间换算成真实处理百分比，不将 `elapsed_ms + remaining_ms` 当作固定预计总时长。启动/配置等发生在文件处理前的错误仍通过诊断文本和退出码报告，宿主必须处理非零退出及异常中断。

启动业务命令、开始上传素材之前，同一批次先提示一次（不要等 `task_id`，也不要编造“任务提交成功”）。WorkBuddy 宿主不要依赖聊天／时间线实时刷进度（平台会折叠工具输出且无法改写气泡）；发提示后用一条命令跑完并等待结束，用户可到最近任务页查看进度。本地终端仍可用 `--progress-json` 看同行刷新；`agent_run_progress.js` 输出纯文字进度行（`正在准备上传素材`，以及 `11.2s file.mp4 · 上传中 79%` / `168.3s file.mp4 · 正在处理，预计还需 262 秒`）。处理阶段按预估剩余时间 R 定频：间隔 = R/10，低于 10s 只显示 1 次，高于 50s 则按 50s 间隔（如 R=600s 约 12 次）。WorkBuddy 使用默认 `agent_run_progress.js` 按首次有效预估定频，并循环 `agent_watch_log.js --compact <日志> <上一条进度>`，把每条返回值作为下一次 Bash `description` 显示在时间线。不要用 `--until-done` / `--stream-progress` 代替可见标题更新。11 秒预估显示一次真实 ETA，600 秒按 50 秒间隔约 12 次；完成检查优先，不等待显示间隔，标题更新仍有模型轮次耗时。Cursor 等流式宿主可用 `agent_run_progress.js --live-progress <业务参数>` 展示每次真实上传百分比与剩余时间，或直接增量读取 CLI 的 `--progress-json` 输出；不要套用 WorkBuddy 的静默等待规则。

> 批量任务、较长视频或较大文件通常需要更多处理时间。任务会在云端持续处理，你可以前往【[查看最近任务](https://wink.cn/editor/recent-task)】查看最新进度，或等待全部完成后通知你。

若进程中断或超时，如实说明自动等待中断，不再承诺自动通知。

为兼容已有 CLI 安装，登录凭据与设备标识仍沿用 `~/.wink-mcp-server/` 历史目录。完整环境说明、参数示例及退出码见 [CLI-TESTING.md](CLI-TESTING.md)。

## 授权和环境管理命令

从 1.14.0 起，授权、环境检查、Skill 读取和云处理统一使用 `wink-cli`：

```sh
wink-cli login --open-browser  # 自动打开授权页，保留完整链接，并持续轮询登录结果
wink-cli status     # 检查登录态（只读、无副作用），输出 WINK_AUTH=connected / disconnected
wink-cli logout     # 清理本地登录凭据
wink-cli doctor     # 环境自检：Node 版本、CLI 版本、登录状态（--json 输出结构化结果）
wink-cli version    # 输出版本号
wink-cli skill      # 读取与当前 CLI 同版本的完整使用 Skill（支持 --json）
wink-cli skill --reference http-api  # 读取当前版本的排障参考
```

- 默认使用正式环境 `release`，与业务命令的 `--env` 默认值一致；联调时统一用内部参数 `--env pre|beta`；自定义地址用 `--base-url`，不能与 `--env` 同用。
- 凭据落盘位置与业务命令完全一致（`~/.wink-mcp-server/cli-credentials/`），登录态跨进程重启有效。
- Windows 下 npm 会生成 `wink-cli.cmd`。
- `logout` 只清理本地凭据；服务端未提供会话撤销接口，远端会话不会因此吊销。

### Skill 随 CLI 升级（1.13.0 起）

连接器的完整使用说明统一维护在 [skills/wink-cli-usage/SKILL.md](skills/wink-cli-usage/SKILL.md)，参考文档放在同目录的 `references/`，一起进入 npm 安装包。`wink-cli skill` 读取当前安装位置的文档，输出版本自动取自 `package.json`，不依赖工作目录，也不登录、联网或修改 WorkBuddy 缓存。`--json` 返回 `name`、`cli_version`、`skill_version`、`reference` 和 `content`。

WorkBuddy 使用本批统一命令配置时，要求 CLI ≥1.14.0。此后每次新任务先通过该入口读取 Skill；本机 CLI 安装升级后，下次读取即获得新文档。Git 推送本身不会更新用户已安装的 CLI，已有会话也不会自动替换读过的内容。可通过现有安装脚本或 `npx --yes meitu-wink-cli@1.14.3 install` 升级；连接器最低版本检查仍遵循自己的门槛，不表示每次重连都安装最新版。

发布时先发布 CLI，再发布首次迁移的连接器。此后仅更新此通用 Skill 的内容无需重新上传连接器；如果读取协议、最低 CLI 要求或连接器元数据改变，仍需发连接器新版本。各专家和独立业务 Skill 的上架包继续在 wink-agents 维护，不在这个随 CLI 更新的范围内。

### 安装到 Agent 技能目录

`npx --yes meitu-wink-cli@1.14.3 install` 在 npm 安装成功后，自动检测本机已有的 Agent 配置目录，并安装 `wink-cli-usage` 入口：

| 检测到的配置目录 | Skill 安装位置 |
|---|---|
| `${CODEX_HOME}` 或 `~/.codex`；`~/.cursor` | `~/.agents/skills/wink-cli-usage/`，Codex 与 Cursor 共用一份 |
| 已有 `~/.agents/skills` | 同上，作为通用入口 |
| `${CLAUDE_CONFIG_DIR}` 或 `~/.claude` | 对应配置目录的 `skills/wink-cli-usage/` |
| `${WORKBUDDY_CONFIG_DIR}` 或 `~/.workbuddy` | 对应配置目录的 `skills/wink-cli-usage/`，补齐本地导入元数据 |

环境变量已设置时以其目录为准；未设置时检查表中的默认位置。仅创建已检测 Agent 的技能子目录，不创建未安装 Agent 的配置根目录。未检测到目标时仍完成 CLI 安装，并提示使用自定义目录。目录约定参考 [Codex](https://learn.chatgpt.com/docs/build-skills)、[Cursor](https://cursor.com/docs/skills)、[Claude Code](https://code.claude.com/docs/en/claude-directory)；WorkBuddy 与本项目现有本地导入器保持一致。同一实际目录会去重；部分 Agent 也扫描其他产品的目录，跨产品的列表展示由对应 Agent 决定。

```sh
npx --yes meitu-wink-cli@1.14.3 install
# 指定技能根目录，代替自动检测；会在该目录下创建 wink-cli-usage/
npx --yes meitu-wink-cli@1.14.3 install --skill-dir "/absolute/agent/skills"
# 只安装 CLI
npx --yes meitu-wink-cli@1.14.3 install --skip-skills
```

入口使用当前 Node.js 与 **npm 全局安装包**的绝对路径，不指向临时 npx 缓存，也不依赖 PATH 中同名的旧 CLI。它只读取说明；执行媒体处理前还需确认业务 CLI 版本一致。后续 CLI 升级后再次读取即可获取完整新版说明；重新执行 `install` 也会更新入口路径。安装完成后刷新 Agent 技能列表或新建会话。

安装器使用 `.wink-cli-managed.json` 记录自己写入的文件摘要，仅更新内容未被修改的受管入口。已有的手写同名 Skill、符号链接或用户新增文件会保留并提示跳过；不影响原有 `wink-cli` 等其他 Skill。某一 Agent 目录写入失败不妨碍其他目录，最终会返回失败状态并列出路径，CLI 本身仍已安装。此流程不登录、不投递任务，也不会注册 WorkBuddy 连接器或专家。

## 项目结构

```text
src/cli.js           命令行入口、登录和流程编排
src/install.js       安装当前版本到 npm 全局目录
src/agent_skills.js  检测 Agent 技能目录、安装与更新动态读取入口
src/cloud_tools.js   功能、档位和专属参数
src/wink_client.js   云端 API 客户端和下载
src/upload_sdk.js    上传协议
src/mp4_metadata.js  MP4/MOV 元信息读取
src/cli_progress.js  单行进度显示
connector/           旧 wink-connector 命令兼容入口
skills/              随 CLI 发布的完整使用 Skill 与排障参考
tests/               CLI、协议及媒体读取测试
wink-cli / wink-cli.cmd      本地启动脚本
```

## 开发验证和打包

```sh
npm test
npm run pack:dry
npm pack
```

测试使用本地模拟接口，不投递真实云处理。npm 包包含源码、启动脚本和使用文档；`node_modules`、测试素材及历史处理结果不打入发布包。当前运行依赖仅 `image-size`，Node.js 仍需用户安装。

兼容旧配置：`wink-connector` 暂时保留为管理命令的兼容入口，复用相同实现与凭据；新配置统一使用 `wink-cli`。


## WorkBuddy 高清修复师 MVP 埋点

WorkBuddy 来源的 `picture_quality`、登录和首次成功命令通过当前环境的 `POST /event/report` 上报，表单包含客户端公共参数和 JSON 字符串 `events`；不会请求文档中的 Mock 地址。来源由 `--channel-id workbuddy`、`WINK_TASK_CHANNEL_ID` 或宿主检测确定，其他来源不启用。`WINK_TELEMETRY=0` 关闭上报。

- `cli_first_run`：首次成功执行受支持的 CLI 命令后上报。安装标识按本机用户持久化于 `~/.wink-mcp-server/tracking/installation-id`，升级保持；成功回执后按 API 环境去重，并发通过锁互斥，失败下次成功运行重试。帮助/版本命令也算成功运行；只读 `status/doctor/skill`、退出登录和其他专家不触发。
- `auth_success`：仅在浏览器授权交换得到有效凭据时上报，使用缓存凭据不重复上报。仅采用响应中的 `data.user_id`，未知保持 null；本地用户关联按服务环境和凭据摘要隔离，不以凭据代替用户 ID。
- `task_submit`：服务端接受提交并返回任务 ID 后上报。CLI 每个素材创建一个服务端任务，故每条 `file_count=1`；重试被拒的提交不算成功投递。`--tracking-prompt` 显式接收本次用户要求，基础脱敏链接、本地路径、邮箱、手机号、证件号和常见凭据后限制 2000 字符，缺少时 null。禁止传入素材内容或整段聊天历史。
- `credit_insufficient`：提交明确返回美豆不足时上报；成功查询余额则携带实际余额。所需金额仅用响应 `data.required_credit`，任务 ID 仅用响应 `data.task_id/msg_id`，没有则 null。充值页透传 `source=workbuddy`，存在服务端任务 ID 时透传 `trigger_task_id`。

所有事件带 ISO 8601 UTC `timestamp`、`source`、`installation_id`、`user_id`、`cli_version`、`expert_id=wink-quality-enhance`。`task_start` 与 `purchase_success` 必须由服务端开始处理状态/支付回调提供，当前不使用提交成功或余额增加代替；因此这两项看板指标尚不能依靠 CLI 统计。尚需联调确认用户 ID 字段、拒绝投递时的任务 ID/所需金额、支付页归因参数消费方式，以及文档 5.2 的最终字段规范。

每次上报在独立后台进程执行，主进程不等待网络；后台有 3 秒总时限，失败不改变业务结果/退出码。凭据经匿名管道传递，不进入参数或埋点事件，不落盘新增副本。除首次运行外，事件采用尽力上报，不承诺失败重试或服务端恰好一次接收；不要将该链路当作计费账本。
