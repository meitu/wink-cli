# Wink CLI 命令行测试

已接入 [CF 功能表](https://cf.meitu.com/confluence/pages/viewpage.action?pageId=715632845)（2026-09-10，版本 5）的全部 13 个命令，并在 1.11.0 中按 website 当前实现新增视频全能修复，共 14 个命令。单档位功能直接省略 `--level`，也兼容显式 `--level 1`。

| 命令 | 功能 | 档位/专属参数 | 图片 type | 视频 type |
|---|---|---|---|---|
| `picture_quality` | 画质修复 | 默认 2，新增 11 专业级、12 AIGC精修 | 2/12/24/55/72/73/177/183 | 1/11/13/54/176/182 |
| `video_repair` | 视频全能修复 | Pro 单档；无需额外参数 | — | 运行时配置，正式环境当前 123 |
| `resolution_repair` | 分辨率修复 | `--sr-mode 0..4`，默认 1（1080p） | 6 | 5 |
| `remove_watermark` | 消除水印 | 1 自动去印（默认）、2 AI去水印 | 8/95 | 3/94 |
| `denoise` | 降噪 | `--strength low/median/high`，默认 low | 10 | 9 |
| `color_enhance` | 色彩增强 | 无需档位 | 15 | 14 |
| `color_unite` | 色调统一 | `--reference` 参考图片（必填） | 93 | 16 |
| `cartoon` | AI动漫 | `--style`、`--formula-type`（必填） | 38（预览） | 25 |
| `night_scene` | 夜景提升 | `--strength low/median`，默认 low | 20 | 19 |
| `video_frame` | 视频补帧 | 1/2/3，默认 1；可选 `--fps` 或 `--factor` | — | 4/36/74 |
| `ai_translation` | AI翻译 | `--target-language`（必填），源语言默认 zh | — | 70 |
| `ai_beauty` | AI美容 | `--gender male/female` 随机选适用风格；也可 `--list-styles` 查询、`--style` 指定，或单独开启附加效果 | 40 | 39 |
| `video_defogging` | 视频去雾 | 无需档位 | — | 107 |
| `old_photo` | 老照片修复 | `--variant standard/quality/shared`，默认 standard | 122/161/164 | — |

画质修复已发布的 7–10 档仍兼容；完整映射见 `wink-cli picture_quality --help`。**消除水印第 2 档按新版 CF 改为 AI 去水印（95/94），不再是自动去文字（42/43）。**

截至本次读取，pre 的 `ai_type_config` 尚未提供 type 74、161、164；CLI 已登记这些映射，服务端开放配置后即可使用。选择当前环境没有配置的玩法，会在上传前报错。

快速测试（项目根目录）：

```sh
./wink-cli denoise --env pre --input "/Users/lixingping/Downloads/00.jpg"
./wink-cli color_enhance --env pre --input "/Users/lixingping/Downloads/00.jpg"
./wink-cli old_photo --env pre --input "/Users/lixingping/Downloads/00.jpg"
./wink-cli picture_quality --level 11 --env pre --input "/Users/lixingping/Downloads/00.jpg"
./wink-cli color_unite --env pre --input "/absolute/photo.jpg" --reference "/absolute/reference.jpg"
./wink-cli cartoon --env pre --input "/absolute/video.mp4" --style xinhaicheng --formula-type 1
./wink-cli ai_translation --env pre --input "/absolute/video.mp4" --target-language en
./wink-cli ai_beauty --env pre --list-styles
./wink-cli ai_beauty -gender male --env pre --input "/absolute/video.mp4"
./wink-cli ai_beauty --gender female --env pre --input "/absolute/photo.jpg"
./wink-cli ai_beauty --env pre --input "/absolute/photo.jpg" --hair-silky
```

AI动漫的风格和效果 ID 必须与对应物料一致；示例的 `xinhaicheng / 1` 需由当前环境支持。AI美容风格 ID 必须来自当前环境的 `--list-styles`，不再通过 `--retouch-params` 手写配置。

`--translate-params`、`--workflow-params` 支持直接 JSON 或 `@文件路径`。翻译默认开启字幕、克隆音色和唇形驱动；如需调整，可用 `--translate-params` 提供完整对象，例如：

```json
{"source_language":"zh","target_language":"en","add_subtitle":1,"clone_timbre":1,"timbre_id":0,"open_lip_driver":1}
```

老照片默认开启 `basic_repair` 和 `super_resolution`，其余开关关闭；`--workflow-params` 可提供完整对象覆盖。更多参数见 `wink-cli <命令> --help`。

## AI 美容

1.12.0 起先调用 `GET /material/ai_beauty/list`，按 `count=50`、`data.cursor` 读取完整 `data.item_list`；查询复用 CLI 域名、`api_key`、客户端公共参数，pre 传 `is_test=1`，beta/release 传 `0`。不移植上传 SDK 的签名算法，不将 CLI 凭据发往网站或 mock 域名。

- `--list-styles [--json]` 无需输入素材，只获取列表，不调用能力配置、上传或投递。JSON 的 `styles` 保留列表项。
- `-gender` / `--gender` 接受 `male` / `female`，与 `--style`、`--list-styles` 互斥。列表接口没有已确认的性别字段，CLI 使用业务指定的名称偏好：`male` 匹配“少年、绅士、硬朗、浪漫”，`female` 匹配“自然、减龄、裸感、女高、浓颜、欧美、紧致”。`name` 中明确的“男/女、male/female”优先，英文按词边界匹配，因此“男士自然”仍属于男性候选；同时包含男女明确标记，或没有明确标记却同时命中男女关键词的名称不参与匹配。先按实际媒体过滤 `media_type_limit`、有效数字物料 ID、非空 `material_conf.parameter`，CLI 1.12.1 起再用 `crypto.randomInt` 从全部适用候选中等概率随机选一个；每个输入独立抽取，未命中时在上传前失败并提示手选。同一任务的充值重投复用既有参数，不重新随机选择；显式 `--style` 不受影响。不会推断 `run_mode` 的性别含义，也不把 `gender` 加到接口请求。成功 JSON 的 `results[].beauty_style` 记录 `material_id`、`name`、`gender`。
- `--style <material_id>` 不设默认值；至少选择风格或开启一个附加效果。`--hair-silky`、`--beauty-double-chin` 默认关闭，也接受显式 `true/false`、`1/0`。媒体限制使用 `media_type_limit`：0 通用、1 图片、2 视频。
- `type_params` 固定携带 `is_mirror:"0"`、`orientation_tag:1`、`preview:0`。`retouch_ai_params` 为 JSON 字符串，其中 `beauty_style` 直接取 `material_conf.parameter`，不改键名、值类型或风格数值。开启的附加效果分别放到 `hair_silky`、`beauty_double_chin`，图片 `media_mode=0`、视频 `1`。
- `right_detail` 参考 website 的 `ai-retouch/ticket.ts`：`source:"1"`、`touch_type:"4"`、`function_id:"672"`；`material_id` 按风格 ID、发质柔顺 `67206`、去双下巴 `67207` 的顺序组合，仅包含本次选择的效果。图/视频算法仍使用 CF 映射 40/39，并经过当前 `ai_type_config` 校验。
- 旧 `--retouch-params` 入口会提示迁移到 `--list-styles` / `--style`，不继续投递缺少 `beauty_style` 层级的配置。网站当前读取的 `materialConf.beautyStyle` 与本次接口文档不同，本实现按用户提供的 `material_conf.parameter` 协议处理。

离线测试见 `tests/test_ai_beauty.js`、`tests/test_ai_beauty_flow.js`，覆盖分页后随机选择非首项、男女候选范围、混合媒体独立抽取、媒体限制、嵌套 JSON、开关组合、环境和错误时禁止上传。随机测试控制抽样索引，不依赖概率断言。2026-09-18 使用已有 CLI 凭据只读请求正式/预发布风格列表，均返回 `HTTP 400, code=10108, 查询失败`；CLI 网关的实际素材接口调用条件待服务端确认。没有执行真实美容任务或消耗美豆。

## 视频全能修复 Pro

```sh
./wink-cli video_repair --input "/absolute/path/video.mp4" --json
```

依据为 website 的 `src/services/workspace/features/definitions/video-repair/{definition,ticket}.ts`、`src/hooks/workspace/useLimitConfig.ts` 及通用请求序列化；2026-09-17 另只读核对了正式环境 `/task/ai_type_config`。

- 配置精确匹配 `task_type=2`、`func_id=65591`、`content_type=2` 的云处理项，再取该项的 `type` 投递。当前正式环境为 123；未开放配置时停止，不回退到旧普通档 22、图片档 124 或 `picture_quality` 的 176/182。
- `type_params` 是 JSON 字符串 `{"enable_shake":"1"}`，表示开启抖动检测。官网没有可调强度、目标帧率、分辨率或组合开关，CLI 也不增加这些选项。
- `right_detail` 是 JSON 字符串 `{"source":"1","touch_type":"4","function_id":"655","material_id":"65511"}`；65591 是匹配服务端配置的功能项 ID，不能拿来替代票据中的 655。
- 只处理完整视频，每个视频一次上传、投递和查询。1.11.2 起不将未知会员状态当作普通账号：已确认身份时使用对应上限，身份未知时仅在普通/会员上限均为有限正数时校验二者的最高值，账号专属限制交投递接口判断。最小时长与 `input_limit` 等素材限制保留；缺失身份不等于获得会员权益。官网的裁剪交互和图片结果页智能校色不属于本命令。
- 保留 CLI `/task/submit`、`/task/query` 协议及 `with_prepare=0`；不搬用网页 `/meitu_ai/delivery.json` 的预处理查询协议，也不虚构 `right_detail.url`。结果仍只返回链接。

`tests/test_video_repair.js` 使用模拟接口验证运行时算法映射、投递参数、单任务流程和异常拦截；真实云处理效果尚未验收。

## 视频时长与账号权益

2026-09-18 只读核对正式环境，视频超清（`type=11`）返回 `min_time=1`、`max_time_normal=60`、`max_time=3600`，单位为秒。CLI 目前只有 `api_key`，没有已确认可用的会员状态协议。1.11.2 修复了未传 `isVip` 就被当作普通用户、超过 60 秒直接拦截的问题；未接入或伪造会员身份，也未把所有账号的个人额度改为 3600 秒。

- `isVip === true` 使用 `max_time`，`isVip === false` 使用 `max_time_normal`；字符串、缺失字段等均视为未知。
- 未知身份且两个上限都是有限正数时，本地只拒绝超过二者最高值的视频；某个上限缺失、无效或为 0 时，不根据另一身份推断共同上限。服务端仍可拒绝超出当前账号权益的请求。
- `min_time` 和 `input_limit.max_duration_ms` 等明确素材限制保持生效；校验时长使用秒，投递的 `duration` 继续使用整数毫秒。
- `tests/test_duration_limits.js` 覆盖身份与时长边界；`tests/test_cli_flow.js` 使用本地 HTTP 模拟服务覆盖 61 秒/3600 秒通过本地校验、服务端拒绝透传以及超出共同上限时不上传。未以真实长视频执行收费处理。

## 准备

去水印结果判定回归见 `tests/test_watermark_result.js`：覆盖未检测到水印/文字、旧成功状态与算法错误冲突、新协议缺少结果链接、旧协议兼容。1.11.1 起这些失败不能返回 `ok=true` 或把原素材链接作为处理结果。

- Node.js 18 或以上，并在项目根目录执行 `npm install`。
- 图片优先通过纯 JavaScript 读取文件头获取宽高。MP4/MOV（以及同容器的 M4V/3GP）优先直接解析容器元信息获取宽高、时长，不需要 ffprobe，也不增加二进制依赖。其他格式或解析失败时回退到可选的 ffprobe；ffprobe 未安装时直接上传、投递。可以通过 `WINK_FFPROBE_PATH` 指定可执行文件的绝对路径。
- 默认环境为 `release`，通过 `--env pre|beta|release` 切换；该参数可以放在功能命令之前或之后。

| 环境 | 接口地址 | 上传 SDK `config.test` |
|---|---|---|
| `pre` | `https://precliapi-winkcut.meitu.com` | `true` |
| `beta` | `https://betacliapi-winkcut.meitu.com` | `false` |
| `release`（默认） | `https://cliapi-winkcut.meitu.com` | `false` |

CLI 的接口地址由 `--env` 决定，不再读取 `WINK_CLI_BASE_URL`。高级联调仍可单独使用 `--base-url`，但不能与 `--env` 同时使用，此时上传为正式通道。旧 `--test` / `--no-test` 参数已停用。

## macOS / Linux

在项目根目录运行：

```sh
./wink-cli --help
./wink-cli picture_quality --help
./wink-cli remove_watermark --help
./wink-cli picture_quality --level 2 --input "/absolute/path/video.mp4"
./wink-cli --env pre picture_quality --level 2 --input "/absolute/path/video.mp4"
./wink-cli remove_watermark --level 2 --env pre --input "/absolute/path/photo.jpg"
```

主命令为 `wink-cli`。使用项目内的 `./wink-cli` 可直接运行当前源码；也可以将项目目录加入当前终端 PATH：

```sh
export PATH="$PWD:$PATH"
hash -r
wink-cli --help
```

## Windows PowerShell

在项目根目录运行：

```powershell
.\wink-cli.cmd --help
.\wink-cli.cmd picture_quality --help
.\wink-cli.cmd picture_quality --level 2 --input "D:\videoFolder,D:\video.mp4"
.\wink-cli.cmd picture_quality --env pre --level 2 --input "D:\videoFolder,D:\video.mp4"
```

也可以将项目目录加入当前终端 PATH 后使用 `wink-cli`：

```powershell
$env:Path = "$($PWD.Path);$env:Path"
wink-cli --help
```

## 执行流程

1. 检查命令、档位、绝对路径，递归展开输入文件夹并去重。
2. 无登录凭据时打开授权页，轮询携带本次 `once_code` 的 `/init/exchange`，获取并保存 `api_key`。
3. 获取 `/task/ai_type_config`。接口失败或配置为空时停止，不上传和投递。
4. 校验当前玩法、媒体类型、参数分支、格式和文件大小。图片读取文件头（最多 1 MiB）；MP4/MOV 读取容器的 movie/track 元信息，跳过视频数据块，支持元信息在文件头或尾部。宽高、时长用于限制检查和投递；时长按 `duration / timescale` 得到秒，投递时转为整数毫秒。分片文件、多个有效视频轨道、头信息不完整等情况回退到 ffprobe。找不到 ffprobe 且没有读到元信息时，不传宽高、时长，由服务端探测；ffprobe 已安装但探测失败仍报错。元信息读取不代表完整解码校验。
5. 上传文件，取得资源 URL，调用 `/task/submit`。
6. 轮询 `/task/query`，处理中的结果继续等待；成功后显示服务端返回的下载链接，不请求链接内容。
7. 输出各文件结果和批次汇总。JSON 的成功结果通过 `result_url` 返回链接，不再返回本地路径或文件大小。

投递返回 code=1999 且 message 包含“美豆不足”时，先查询并记录余额，再按环境打开充值页；每 5 秒查询一次，余额增加后重新投递，最多等待 300 秒。单个文件失败后继续下一文件。

首次执行需要在浏览器完成授权。登录失效时，在原命令末尾加 `--relogin`；重新授权会忽略环境变量和磁盘缓存中的 key（显式 `--api-key` 除外）。

登录凭据按服务地址分别保存在 `~/.wink-mcp-server/cli-credentials/`。首次使用某个环境需重新授权，不自动复用旧的共用缓存。显式提供 `--api-key` 或 `WINK_CLI_API_KEY` 时，应提供所选环境对应的凭据。

输入必须使用当前操作系统的路径；macOS 上不能使用 `D:\...`。含空格的路径和多个输入组成的参数都应加双引号。

无需指定结果目录。`--output` 和 `--force` 仅为兼容旧命令保留，当前不生效。

## 输出与退出码

添加 `--json` 可在 stdout 获取结果汇总，过程日志输出到 stderr。

每个文件只占一条状态行，上传、处理、充值等待及最终成功或失败状态都覆盖同一行，结束后才换行。以下为同一行在不同时刻的内容：

```text
/path/photo.jpg 上传中：38%
/path/photo.jpg 处理中：剩余1分20秒
/path/photo.jpg 完成：14.1秒 → https://example.com/result.jpg
```

处理剩余时间将服务端 `remaining_elapsed` 的毫秒数换算为分、秒；未返回时间时显示“剩余时间估算中”。完成行直接显示结果链接。重定向输出保留普通文本行，不包含终端控制字符。

| 退出码 | 含义 |
|---|---|
| 0 | 帮助成功或所有处理任务成功 |
| 1 | 参数、登录、配置或初始化失败 |
| 2 | 部分任务失败 |
| 3 | 所有处理任务失败 |

`--interval` 控制查询间隔，默认 3 秒；`--timeout` 控制单任务轮询等待，默认 600 秒。查询超时的日志保留任务 ID。

## 验证范围

`npm test` 通过本地模拟接口验证 CF 的 40 条媒体/玩法映射及专属参数，并覆盖 CLI 参数与档位、带授权码轮询、混合媒体输入、配置失败拦截、视频超长拦截、投递错误提示、任务轮询及结果链接输出。测试使用模拟服务，不代表真实账号授权及云端算法处理已完成联调。
