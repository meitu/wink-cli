# HTTP 排障参考（随 CLI 发布）

通过 `wink-cli skill --reference http-api` 读取当前安装版本的参考；加 `--json` 可同时获取 `cli_version` 和 `skill_version`。以下为 CLI 当前实现的协议摘要，不是独立直连接口教程。具体请求与错误以当前 CLI 实际输出为准，不猜测服务端配置、错误码或账号权限。

## 正常流程

检查命令与输入 → 登录授权 → 获取能力配置（AI 美容还先获取风格列表）→ 媒体校验 → 上传 → 投递 → 轮询 → 输出处理结果链接。CLI 不自动下载结果，也不为了校验结果下载整段视频做 MD5 比较。

| 操作 | 请求 | 当前实现要点 |
|---|---|---|
| 授权页 | `GET /init/auth` | URL 同时携带 `once_code`、`client_id`；不要漏掉 Windows URL 中 `&` 后的参数 |
| 换取凭据 | `GET /init/exchange` | 使用同一次授权的 `once_code` 与 `client_id`；凭据由 CLI 保存，不向用户索要或输出 |
| 云处理能力 | `GET /task/ai_type_config` | 公共客户端参数；以返回配置匹配功能、档位、媒体类型及约束 |
| AI 美容风格 | `GET /material/ai_beauty/list` | 公共客户端参数、`count`、`cursor`，使用当前环境的 `api_key`；查询本身不投递任务 |
| 投递 | `POST /task/submit` | `application/x-www-form-urlencoded` 请求体，由 CLI 构造公共参数及 `source_url`、`type`、`content_type`、`ext_params`、`right_detail` 等，不能用旧的单个 `resource_url` 示例代替 |
| 查询 | `GET /task/query` | 公共客户端参数加 `msg_id`；使用与投递一致的账号、应用和环境 |
| 美豆余额 | `GET /subscribe/remain_amount_info` | 美豆不足时先记录 `total_amount` 再打开购买页，每5秒查询，最多300秒；余额增加后重试投递 |

客户端公共参数由当前实现生成，包含 `client_id`、`version`、`gnum` 等。`api_key` 与可选的 `Access-Token` 不是同一个凭据，不自行互换。正常业务始终通过 CLI，不将 CLI 凭据发给网站、Mock 或素材下载域名。

## 环境与授权

连接器默认正式环境。内部排障需要保持授权、风格查询、上传、投递和轮询环境一致：

| 环境 | Base URL |
|---|---|
| release | `https://cliapi-winkcut.meitu.com` |
| beta | `https://betacliapi-winkcut.meitu.com` |
| pre | `https://precliapi-winkcut.meitu.com` |

管理命令和业务命令统一用内部 `--env` 参数选择环境，必要时可单独用 `--base-url` 指定地址，两者不能同时使用。旧 `wink-connector` 兼容入口仍支持历史环境变量；新 `wink-cli` 入口不依赖这些变量。授权、状态查询与业务处理必须使用相同环境。环境选项不作为面向普通用户的帮助内容展示。

凭据沿用 `~/.wink-mcp-server/cli-credentials/` 历史目录，按接口域名区分。日常只使用 `wink-cli doctor --json` 或 `status` 判断本地凭据状态，在线有效性由服务端判断，不读取、回显或写入对话。发现未登录或授权明确失效时使用连接器授权流程，面板不可用时执行 `wink-cli login` 并等待同一进程完成。

`/init/exchange` 在浏览器回调前可能返回 `20001`；应保留同一次 `once_code` 持续等待当前登录流程，不因每次等待提示都生成新码，也不跨环境交换。连接器的授权等待上限为300秒，不据此推测服务端授权码有效期。

## 参数与结果定位

- AI 美容先读取完整实时列表；`--style` 使用 `material_id`。`--gender` 仅用于本地按偏好和媒体适用范围随机选风格，不是直接传给服务端的性别参数。
- 当前美容参数优先取 `material_conf.beauty_style` 非空对象，否则兼容旧 `material_conf.parameter`；两者都无效时停止上传。CLI 负责组装 JSON 字符串形式的 `retouch_ai_params`，用户不手写该协议。
- 投递成功通常从 `data.msg_id` 取得任务 ID，兼容旧 `data.task_id`。成功投递不表示处理成功；查询进度100%也不单独作为成功依据。
- 当前结果优先从 `data.result.media_info_list` 等算法产物字段提取，顶层 `data.url` 可能是原素材。以最终 CLI JSON 中 `results[].ok` 与 `result_url` 为交付依据，不直接选抓包中第一个 URL。
- 查询失败或超时但已有任务 ID 时，不重新投递；提供任务标识与 [查看最近任务](https://wink.cn/editor/recent-task)。
- 去水印未检测到水印、算法失败、缺少结果链接，都应报告失败；不得把原素材链接当作处理结果。
- 媒体约束由实时配置与 CLI 校验决定，不凭“普通用户”字样推断账号会员档位，不自动切片或降档。

排障报告保留请求方法、路径、HTTP 状态、服务端 `code`／`message` 和已有任务 ID。只转述实际证据，不把本地拒绝说成服务端已处理，也不将相同文件名或尺寸当作结果与原文件相同的证据。
