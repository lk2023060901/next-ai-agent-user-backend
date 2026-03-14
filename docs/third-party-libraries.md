# OpenClaw 第三方库清单（基于根 package.json）

## 说明

- 分析范围：根 `package.json` 中的 `dependencies` 与 `devDependencies`
- 总数：73 个第三方包
  - 运行时依赖：53
  - 开发依赖：20
- 判定标准：
  - `已使用（源码）`：在 `src/`、`extensions/`、`apps/`、`ui/`、`scripts/`、`test/` 中发现直接 `import` / `require` / `import()` 使用
  - `已使用（脚本）`：未发现源码导入，但在 `package.json` scripts 中作为构建、测试或检查工具使用
  - `已使用（类型支持）`：主要作为 TypeScript 类型包使用，无运行时导入
  - `未发现直接使用`：未发现源码导入，也未发现明确脚本使用
- 注意：这里统计的是“项目直接声明的依赖”，不是 transitive dependencies

## 运行时依赖

| 包名 | 用途 | 主要位置 | 状态 |
| --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | ACP 协议 client/server、事件映射与协议对象 | `src/acp/client.ts`, `src/acp/server.ts` | 已使用（源码） |
| `@aws-sdk/client-bedrock` | AWS Bedrock 模型发现与集成 | `src/agents/bedrock-discovery.ts` | 已使用（源码） |
| `@buape/carbon` | Discord 组件、消息卡片和交互 UI 构造 | `src/discord/components.ts`, `src/discord/client.ts` | 已使用（源码） |
| `@clack/prompts` | CLI 交互式提示、进度与向导 UI | `src/cli/progress.ts`, `src/commands/doctor.ts` | 已使用（源码） |
| `@discordjs/voice` | Discord 语音连接和语音管理 | `src/discord/voice/manager.ts` | 已使用（源码） |
| `@grammyjs/runner` | Telegram bot polling/runner 生命周期管理 | `src/telegram/bot.ts`, `src/telegram/monitor.ts` | 已使用（源码） |
| `@grammyjs/transformer-throttler` | Telegram API 请求节流 | `src/telegram/bot.ts` | 已使用（源码） |
| `@homebridge/ciao` | Bonjour/mDNS 服务发现与广播 | `src/infra/bonjour.ts` | 已使用（源码） |
| `@larksuiteoapi/node-sdk` | Feishu/Lark API 客户端 | `extensions/feishu/src/client.ts`, `extensions/feishu/src/docx.ts` | 已使用（源码） |
| `@line/bot-sdk` | LINE bot webhook、收发消息与下载 | `src/line/bot.ts`, `src/line/webhook.ts` | 已使用（源码） |
| `@lydell/node-pty` | PTY 终端进程支持 | `src/process/supervisor/adapters/pty.ts` | 已使用（源码） |
| `@mariozechner/pi-agent-core` | Pi agent 核心抽象、工具运行时、bash tools 支撑 | `src/agents/bash-tools.exec.ts`, `src/agents/apply-patch.ts` | 已使用（源码） |
| `@mariozechner/pi-ai` | 模型、认证、provider 适配与调用 | `src/agents/model-auth.ts`, `src/agents/auth-profiles/oauth.ts` | 已使用（源码） |
| `@mariozechner/pi-coding-agent` | 核心 coding-agent 运行时、compaction、session 模型 | `src/agents/compaction.ts`, `src/agents/model-forward-compat.ts` | 已使用（源码） |
| `@mariozechner/pi-tui` | TUI 组件和终端交互能力 | `src/tui/commands.ts`, `src/tui/components/markdown-message.ts` | 已使用（源码） |
| `@mozilla/readability` | 从网页内容中提取可读正文 | `src/agents/tools/web-fetch-utils.ts` | 已使用（源码） |
| `@sinclair/typebox` | 工具/插件输入 schema 定义 | `src/agents/model-scan.ts`, `extensions/diffs/src/tool.ts` | 已使用（源码） |
| `@slack/bolt` | Slack event app / monitor 框架 | `src/slack/monitor/context.ts`, `src/slack/monitor/events/messages.ts` | 已使用（源码） |
| `@slack/web-api` | Slack API 客户端、blocks、actions、文件读取 | `src/slack/client.ts`, `src/slack/actions.ts` | 已使用（源码） |
| `@whiskeysockets/baileys` | WhatsApp Web 协议接入 | `src/web/inbound/monitor.ts`, `src/web/login-qr.ts` | 已使用（源码） |
| `ajv` | JSON Schema 校验，协议/插件/secrets 校验 | `src/plugins/schema-validator.ts`, `src/gateway/server-methods/validation.ts` | 已使用（源码） |
| `chalk` | 终端着色、主题与启动日志美化 | `src/logging/subsystem.ts`, `src/terminal/theme.ts` | 已使用（源码） |
| `chokidar` | 配置、Canvas、skills、memory 变更监听 | `src/gateway/config-reload.ts`, `src/agents/skills/refresh.ts` | 已使用（源码） |
| `cli-highlight` | TUI 代码高亮 | `src/tui/theme/theme.ts` | 已使用（源码） |
| `commander` | CLI 命令树与参数解析 | `src/cli/acp-cli.ts`, `src/cli/browser-cli-actions-input/register.ts` | 已使用（源码） |
| `croner` | cron 调度 | `src/cron/schedule.ts` | 已使用（源码） |
| `discord-api-types` | Discord API 类型与 payload 结构 | `src/discord/components.ts`, `src/agents/tools/discord-actions-moderation-shared.ts` | 已使用（源码） |
| `dotenv` | `.env` 文件加载 | `src/infra/dotenv.ts` | 已使用（源码） |
| `express` | 浏览器 relay、媒体服务、LINE/MSTeams 等 HTTP 服务 | `src/browser/server.ts`, `src/media/server.ts`, `src/line/webhook.ts` | 已使用（源码） |
| `file-type` | 文件类型/MIME 探测 | `src/media/mime.ts` | 已使用（源码） |
| `grammy` | Telegram bot 主框架 | `src/telegram/allowed-updates.ts`, `src/telegram/bot/delivery.send.ts` | 已使用（源码） |
| `https-proxy-agent` | 代理环境下的 HTTP/WS 连接支持 | `src/discord/monitor/gateway-plugin.ts`, `extensions/feishu/src/client.ts` | 已使用（源码） |
| `ipaddr.js` | IP 地址分类、私网判断 | `src/shared/net/ip.ts` | 已使用（源码） |
| `jiti` | 运行时加载 TS/ESM 插件与 SDK alias | `src/plugins/loader.ts`, `src/plugin-sdk/root-alias.cjs` | 已使用（源码） |
| `json5` | 配置文件、frontmatter、宽松 JSON 解析 | `src/config/io.ts`, `src/cli/config-cli.ts` | 已使用（源码） |
| `jszip` | ZIP 压缩包处理与归档测试 | `src/infra/archive.ts`, `src/media/store.test.ts` | 已使用（源码） |
| `linkedom` | 轻量 DOM 解析，用于网页抽取和 HTML 安全测试 | `src/agents/tools/web-fetch-utils.ts`, `src/agents/tools/web-fetch-visibility.ts` | 已使用（源码） |
| `long` | 未发现直接用途；疑似历史遗留或预留依赖 | 未发现直接导入 | 未发现直接使用 |
| `markdown-it` | Markdown 解析与渲染（核心 markdown/matrix 等） | `src/markdown/ir.ts`, `extensions/matrix/src/matrix/format.ts` | 已使用（源码） |
| `node-edge-tts` | TTS 后端（Edge TTS） | `src/tts/tts-core.ts` | 已使用（源码） |
| `opusscript` | Discord 语音的 Opus 编码/解码支持 | `src/discord/voice/manager.ts` | 已使用（源码） |
| `osc-progress` | 终端进度条/进度 UI | `src/cli/progress.ts` | 已使用（源码） |
| `pdfjs-dist` | PDF 文本提取 | `src/media/pdf-extract.ts` | 已使用（源码） |
| `playwright-core` | 浏览器自动化与 Playwright 会话层 | `src/browser/pw-session.ts`, `src/browser/pw-tools-core.downloads.ts` | 已使用（源码） |
| `qrcode-terminal` | CLI 中输出二维码（登录、配对等） | `src/cli/qr-cli.ts`, `src/web/session.ts` | 已使用（源码） |
| `sharp` | 图片处理、压缩、截图转换 | `src/media/image-ops.ts`, `src/web/media.test.ts` | 已使用（源码） |
| `sqlite-vec` | 向量记忆后端 | `src/memory/sqlite-vec.ts`, `scripts/sqlite-vec-smoke.mjs` | 已使用（源码） |
| `tar` | TAR 压缩包处理、备份、安装 | `src/commands/backup.ts`, `src/infra/archive.ts`, `src/plugins/install.test.ts` | 已使用（源码） |
| `tslog` | 结构化日志基础库 | `src/logging/logger.ts`, `src/logging/subsystem.ts` | 已使用（源码） |
| `undici` | HTTP 客户端与 fetch 支撑 | `src/agents/tools/web-tools.fetch.test.ts`, `src/browser/server.auth-token-gates-http.test.ts` | 已使用（源码） |
| `ws` | WebSocket 通信层（Gateway、Canvas、browser relay 等） | `src/agents/openai-ws-connection.ts`, `src/canvas-host/server.ts` | 已使用（源码） |
| `yaml` | YAML/frontmatter/镜像摘要解析 | `src/markdown/frontmatter.ts`, `src/docker-image-digests.test.ts` | 已使用（源码） |
| `zod` | 配置 schema、插件 schema、doctor 配置分析 | `src/config/zod-schema.agent-runtime.ts`, `src/channels/plugins/config-schema.ts` | 已使用（源码） |

## 开发依赖

| 包名 | 用途 | 主要位置 | 状态 |
| --- | --- | --- | --- |
| `@grammyjs/types` | Telegram 类型定义（编译期） | `src/telegram/bot/types.ts`, `src/telegram/send.ts` | 已使用（源码/类型） |
| `@lit-labs/signals` | 未发现根仓库直接使用；更像 UI 预留依赖 | 未发现直接导入 | 未发现直接使用 |
| `@lit/context` | Lit 上下文支持，当前用于 A2UI/前端相关代码 | `apps/shared/OpenClawKit/Tools/CanvasA2UI/bootstrap.js` | 已使用（源码） |
| `@types/express` | Express 的 TypeScript 类型支持 | TypeScript 隐式使用 | 已使用（类型支持） |
| `@types/markdown-it` | markdown-it 的 TypeScript 类型支持 | TypeScript 隐式使用 | 已使用（类型支持） |
| `@types/node` | Node.js 的 TypeScript 类型支持 | TypeScript 隐式使用 | 已使用（类型支持） |
| `@types/qrcode-terminal` | qrcode-terminal 的 TypeScript 类型支持 | TypeScript 隐式使用 | 已使用（类型支持） |
| `@types/ws` | ws 的 TypeScript 类型支持 | TypeScript 隐式使用 | 已使用（类型支持） |
| `@typescript/native-preview` | `pnpm tsgo` 所用的实验性 TypeScript 原生检查能力 | `package.json` scripts 中的 `pnpm tsgo` | 已使用（脚本） |
| `@vitest/coverage-v8` | Vitest 覆盖率收集插件 | `test:coverage` 脚本 | 已使用（脚本） |
| `jscpd` | 重复代码检测 | `dup:check`, `dup:check:json` 脚本 | 已使用（脚本） |
| `lit` | Web UI / Lit 组件运行库，以及 A2UI bootstrap 代码 | `ui/src/ui/app.ts`, `ui/src/i18n/lib/lit-controller.ts` | 已使用（源码） |
| `oxfmt` | 代码格式化工具 | `format*` 脚本 | 已使用（脚本） |
| `oxlint` | 代码 lint 工具 | `lint*` 脚本 | 已使用（脚本） |
| `oxlint-tsgolint` | 与 `tsgo` 相关的 TypeScript 语义 lint 能力 | `check` 脚本中的 `pnpm tsgo` | 已使用（脚本） |
| `signal-utils` | 未发现根仓库直接使用；更像 UI/实验性预留依赖 | 未发现直接导入 | 未发现直接使用 |
| `tsdown` | 构建打包工具 | `build`, `build:docker`, `build:strict-smoke` 脚本 | 已使用（脚本） |
| `tsx` | 直接运行 TypeScript 脚本 | 多个 `node --import tsx ...` 构建/检查脚本 | 已使用（脚本） |
| `typescript` | TypeScript 编译器，用于 d.ts 构建和类型检查生态 | `build:plugin-sdk:dts` 中的 `tsc -p ...` | 已使用（脚本） |
| `vitest` | 测试框架 | `test:*` 脚本与大量 `*.test.ts` | 已使用（源码/脚本） |

## 未发现直接使用的包

下面这些包在本次基于根 `package.json` 的扫描中，未发现明确源码导入或明确脚本使用：

- `long`
- `@lit-labs/signals`
- `signal-utils`

这不一定等于“100% 可以删除”，但至少说明：

1. 在当前主仓库代码中没有明显直接用法
2. 更可能是历史遗留、预留依赖，或只在未纳入本次扫描范围的生成物/外部包中间接使用
3. 如果要精简依赖，建议优先从这 3 个包开始做删减验证

## 备注

- 一些依赖虽然没有运行时导入，但确实承担了构建、测试、格式化或类型支持职责，例如：`typescript`、`vitest`、`oxfmt`、`oxlint`、`@types/*`
- 一些依赖主要被 `extensions/*` 或 `ui/*` 使用，但仍然由根 `package.json` 统一声明，因此也算项目直接依赖
