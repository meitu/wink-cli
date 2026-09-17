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
| `ai_beauty` | AI美容 | `--retouch-params` 效果配置（必填） | 40 | 39 |
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
./wink-cli ai_beauty --env pre --input "/absolute/photo.jpg" --retouch-params '@/absolute/effect.json'
```

AI动漫的风格和效果 ID 必须与对应物料一致；示例的 `xinhaicheng / 1` 需由当前环境支持。AI美容 JSON 传入效果的 `parameter`/`material_conf` 对象。

`--translate-params`、`--retouch-params`、`--workflow-params` 支持直接 JSON 或 `@文件路径`。翻译默认开启字幕、克隆音色和唇形驱动；如需调整，可用 `--translate-params` 提供完整对象，例如：

```json
{"source_language":"zh","target_language":"en","add_subtitle":1,"clone_timbre":1,"timbre_id":0,"open_lip_driver":1}
```

老照片默认开启 `basic_repair` 和 `super_resolution`，其余开关关闭；`--workflow-params` 可提供完整对象覆盖。更多参数见 `wink-cli <命令> --help`。

## 视频全能修复 Pro

```sh
./wink-cli video_repair --input "/absolute/path/video.mp4" --json
```

依据为 website 的 `src/services/workspace/features/definitions/video-repair/{definition,ticket}.ts`、`src/hooks/workspace/useLimitConfig.ts` 及通用请求序列化；2026-09-17 另只读核对了正式环境 `/task/ai_type_config`。

- 配置精确匹配 `task_type=2`、`func_id=65591`、`content_type=2` 的云处理项，再取该项的 `type` 投递。当前正式环境为 123；未开放配置时停止，不回退到旧普通档 22、图片档 124 或 `picture_quality` 的 176/182。
- `type_params` 是 JSON 字符串 `{"enable_shake":"1"}`，表示开启抖动检测。官网没有可调强度、目标帧率、分辨率或组合开关，CLI 也不增加这些选项。
- `right_detail` 是 JSON 字符串 `{"source":"1","touch_type":"4","function_id":"655","material_id":"65511"}`；65591 是匹配服务端配置的功能项 ID，不能拿来替代票据中的 655。
- 只处理完整视频，每个视频一次上传、投递和查询。当前 CLI 按能力配置的普通用户时长上限校验；当日正式配置为 1–60 秒。服务端另有会员上限，但 CLI 尚未解析会员身份，不自动放宽。官网的裁剪交互和图片结果页智能校色不属于本命令。
- 保留 CLI `/task/submit`、`/task/query` 协议及 `with_prepare=0`；不搬用网页 `/meitu_ai/delivery.json` 的预处理查询协议，也不虚构 `right_detail.url`。结果仍只返回链接。

`tests/test_video_repair.js` 使用模拟接口验证运行时算法映射、投递参数、单任务流程和异常拦截；真实云处理效果尚未验收。

## 准备

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
