# Wink CLI

用于图片和视频云处理的命令行工具。支持授权登录、本地媒体校验、上传、任务投递、轮询及结果链接输出。

## 安装和运行

上传到 GitHub 仓库 `meitu/wink-cli` 后，用户可以运行：

```sh
npx github:meitu/wink-cli install
wink-cli --help
```

需要先安装 Node.js（建议使用受支持的 LTS 版本）、npm 和 Git，并能访问该仓库。私有仓库需要预先配置 Git 访问权限；安装时需要联网下载依赖。此命令将本次下载的版本打包后安装到 npm 全局目录，不依赖 npx 缓存长期保留，不触发登录或云处理。更新时重新运行同一安装命令；也可指定 Git tag，例如 `npx github:meitu/wink-cli#v1.10.0 install`（需先创建对应 tag）。

若全局目录没有写入权限，可使用 `npx github:meitu/wink-cli install --prefix <可写目录>`。macOS/Linux 将 `<可写目录>/bin` 加入 PATH，Windows 将 `<可写目录>` 加入用户 Path，再重新打开终端。安装后使用 `wink-cli`；旧的 `wink` 命令不再由本包注册。

卸载使用 `npm uninstall -g wink-cli`；自定义安装前缀时追加相同的 `--prefix <目录>`。安装帮助：`wink-cli install --help`。

如果此前安装过旧包 `wink-cli-v2`，请先运行 `npm uninstall -g wink-cli-v2`，再执行上面的安装命令，避免旧包占用同名命令。使用自定义 `--prefix` 时，卸载也需要指定相同前缀。

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

CLI 不推断性别偏好；需要显式指定 `--gender`、`--style` 或至少开启一个附加效果才可处理。发质柔顺、去双下巴默认关闭，两个开关可以单独使用，也能与 `--gender` 或 `--style` 组合。CLI 每次处理前获取完整风格列表，验证物料 ID 和图片/视频适用范围，将服务端的 `material_conf.parameter` 原样作为 `beauty_style`。图片的附加效果使用 `media_mode=0`，视频使用 `1`，关闭的效果不传。旧的 `--retouch-params` 改为上述风格选择方式，不再手写或猜测美容参数。

处理流程：检查命令和输入 → 检查登录凭据，必要时授权登录 → 拉取完整素材列表 → 获取能力配置 → 按当前媒体与 gender 随机选素材，完成媒体及能力校验 → 上传 → 投递 → 轮询 → 返回结果链接。`--style` 仍固定使用指定物料，不参与随机选择。

列表查询使用当前 CLI 环境的 `/material/ai_beauty/list` 与现有 `api_key`；查询不上传素材或投递任务。接口失败时处理流程在上传前停止。2026-09-18 对正式/预发布接口的只读联调均返回 `HTTP 400 / code=10108 / 查询失败`，仍需确认服务端已开放 CLI 调用；本地模拟协议测试不代表真实云处理已验收。

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

为兼容已有 CLI 安装，登录凭据与设备标识仍沿用 `~/.wink-mcp-server/` 历史目录。完整环境说明、参数示例及退出码见 [CLI-TESTING.md](CLI-TESTING.md)。

## 连接器命令（wink-connector）

面向 WorkBuddy 连接器（CLI+Skill 方案）的壳脚本命令层，随包一起安装，只包装既有能力，不改动业务逻辑：

```sh
wink-connector login      # 授权登录：10 秒内输出 https 授权链接，并轮询换取 api_key
wink-connector status     # 检查登录态（只读、无副作用），输出 WINK_AUTH=connected / disconnected
wink-connector logout     # 清理本地登录凭据
wink-connector doctor     # 环境自检：Node 版本、CLI 版本、登录状态（--json 输出结构化结果）
wink-connector version    # 输出版本号
```

- 默认使用正式环境 `release`，与业务命令的 `--env` 默认值一致；联调可临时用 `WINK_CLI_ENV=pre|beta` 或 `WINK_CLI_BASE_URL` 覆盖。
- 凭据落盘位置与业务命令完全一致（`~/.wink-mcp-server/cli-credentials/`），登录态跨进程重启有效。
- Windows 下 npm 会生成 `wink-connector.cmd`。
- `logout` 只清理本地凭据；服务端未提供会话撤销接口，远端会话不会因此吊销。

## 项目结构

```text
src/cli.js           命令行入口、登录和流程编排
src/install.js       安装当前版本到 npm 全局目录
src/cloud_tools.js   功能、档位和专属参数
src/wink_client.js   云端 API 客户端和下载
src/upload_sdk.js    上传协议
src/mp4_metadata.js  MP4/MOV 元信息读取
src/cli_progress.js  单行进度显示
connector/           WorkBuddy 连接器壳脚本命令层（wink-connector）
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
