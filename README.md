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

卸载使用 `npm uninstall -g wink-cli-v2`；自定义安装前缀时追加相同的 `--prefix <目录>`。安装帮助：`wink-cli install --help`。

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

```sh
./wink-cli denoise --env pre --input "/absolute/path/photo.jpg"
./wink-cli ai_translation --env pre --input "/absolute/path/video.mp4" --target-language en
```

## 登录、输入和输出

- 默认环境为 `release`，可用 `--env pre|beta|release` 切换。仅 pre 使用测试上传通道。
- 首次运行打开授权页，CLI 轮询本次授权码获取 api_key；`--relogin` 可重新授权。
- 输入使用绝对路径，支持多个文件和文件夹，以英文逗号分隔；文件夹会递归展开。
- 处理成功后仅显示下载链接，不自动下载、不创建结果目录；`--json` 的每个成功结果通过 `result_url` 返回链接。旧命令中的 `--output` 和 `--force` 继续接受但不再生效。
- 每个文件的上传、处理和完成状态在终端同一行更新；`--json` 输出结构化结果。
- 投递返回 `code=1999` 且 `message` 包含“美豆不足”时，先调用 `/subscribe/remain_amount_info` 记录 `total_amount`，再按 `--env` 打开对应充值页；每 5 秒查询余额，余额大于充值前的记录值后复用已上传文件重新投递，不需要额外命令参数。
- 每个文件的充值等待最多 300 秒。余额不变或减少时继续等待；首次余额获取失败时显示错误，不将未知余额当作 0。重新投递仍提示美豆不足时重新记录基准余额，在剩余时间内等待再次增加，不重复打开充值页。后续投递是否成功由服务端判断。
- 余额请求沿用所选环境的 API 地址及现有 `api_key`；客户端配置了账号 `Access-Token` 时也会携带该请求头。服务端是否支持 CLI 的 `api_key` 鉴权仍需真实接口联调确认。

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
