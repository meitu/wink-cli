---
name: wink-cli-usage
description: 使用已安装的 Wink CLI 对图片或视频做云端画质修复、超分、美颜、降噪和去水印时，先读取当前 CLI 的完整使用说明与真实支持参数。
---

# Wink CLI 云处理

每次新的云处理任务，先执行下面的只读命令并阅读完整输出。命令使用本次安装的 Node.js 和 CLI 绝对路径，避免误用 PATH 中的旧版本。

```{{SHELL}}
{{READ_COMMAND}}
```

完整使用说明随 CLI 发布；CLI 升级后重新读取，不沿用旧会话里的参数表。此命令不登录、不联网、不上传素材，也不消耗美豆。需要结构化内容与版本信息时，在命令末尾加 `--json` 并阅读 `content`。

按返回的说明检查环境、登录状态、功能与档位，再执行用户授权的处理。若业务命令 `wink-cli --version` 与读取的 CLI 版本不一致，先修正 PATH 或使用该安装目录中的 CLI。不要用旧版业务命令配合新版说明。

命令不存在、退出失败或正文缺失时，停止业务投递并说明需要重新运行 `npx --yes --userconfig=/dev/null github:meitu/wink-cli install` 修复安装；不要凭记忆猜测参数。排障时可在上述读取命令末尾加 `--reference http-api` 获取同版本参考。

登录由 CLI 的正常流程处理；WorkBuddy 中也可通过连接器完成授权。读取 Skill 不代表用户已授权收费处理。只交付 CLI 判定成功的真实结果链接，显示为“查看优化后素材”，最近任务入口显示为“查看最近任务”。不要回显凭据或将原素材链接作为成功结果。

安装与 npm 路径查询使用空的用户配置，避免 npm 自动读取含令牌的 `~/.npmrc`：上述 `--userconfig=/dev/null` 适用于 macOS/Linux；Windows 使用 `npx.cmd --yes --userconfig=NUL github:meitu/wink-cli install` 和 `npm.cmd --userconfig=NUL root -g`。保留这些参数，不读取或打印 `.npmrc`、完整环境变量或 npm 配置，不要求用户提供 npm Token，也不关闭 Agent 的凭据保护。若自定义镜像、代理或安装目录因隔离用户配置而不可用，报告实际错误，可由用户明确指定非敏感配置，不恢复读取凭据文件。
