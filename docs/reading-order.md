# OpenClaw 代码阅读顺序

## 阅读原则

建议按“先主干、后分支；先运行时、后能力层；先一条真实链路、后横切模块”的顺序读。
这样不会过早陷进局部实现，也更容易建立整体心智模型。

## 推荐阅读顺序

### 1. 先看项目入口和产品边界

先读：

- `README.md`
- `package.json`
- `pnpm-workspace.yaml`

目标：

- 确认 OpenClaw 是什么系统
- 明确它是以 Gateway 为控制平面的多渠道 AI agent 系统
- 建立对 CLI、Gateway、UI、extensions、apps 这些大块的初始边界感

### 2. 看 CLI 是怎么把系统启动起来的

顺序：

- `src/entry.ts`
- `src/cli/run-main.ts`
- `src/cli/program.ts`
- `src/cli/gateway-cli/run.ts`

重点问题：

- 进程从哪里启动
- CLI 参数如何解析
- 命令如何按需注册
- `gateway run` 如何进入真正的运行时

### 3. 看 Gateway 控制平面的装配

顺序：

- `src/gateway/server.impl.ts`
- `src/gateway/server-startup.ts`
- `src/gateway/config-reload.ts`
- `src/gateway/config-reload-plan.ts`
- `src/gateway/server-reload-handlers.ts`

重点问题：

- Gateway 启动时先做什么，后做什么
- 配置、Secrets、插件、channels、cron、heartbeat、WS 是怎么被装起来的
- 哪些配置变更支持热更新，哪些必须重启

这部分是全仓库最重要的主干。

### 4. 看 Gateway 的请求模型和事件模型

顺序：

- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-chat.ts`

重点问题：

- 客户端和节点是怎么通过 WS 接进来的
- Gateway methods 是怎么组织的
- 聊天流式事件是怎么广播到 UI / TUI / node 的

### 5. 追一条最核心的业务链

推荐追“渠道入站消息 -> agent 执行 -> 回送”。

顺序：

- `src/auto-reply/dispatch.ts`
- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/commands/agent.ts`
- `src/commands/agent/delivery.ts`

重点问题：

- 渠道消息进入后，什么时候被视为 native command，什么时候进入 agent turn
- 媒体理解、链接理解、session 初始化发生在什么阶段
- agent 的结果如何转成 outbound payload 再发回渠道

这是 OpenClaw 的主价值链。

### 6. 再看 agent 真正怎么跑

顺序：

- `src/agents/pi-embedded.ts`
- `src/agents/pi-embedded-runner/*`
- `src/agents/cli-runner.ts`

重点问题：

- embedded runtime 和 CLI backend 的分工是什么
- model fallback、streaming、session 续接是怎么做的
- agent event 是如何发回 Gateway/UI 的

### 7. 看路由和 session 模型

顺序：

- `src/routing/resolve-route.ts`
- `src/routing/session-key.ts`
- `src/config/sessions/*`
- `src/sessions/*`

重点问题：

- 一条消息如何选中 agent
- sessionKey 如何生成
- direct/group/thread 场景下 session 如何隔离或复用
- last-route 与 main session 的关系是什么

这一层是理解 OpenClaw 运行语义的关键。

### 8. 再看插件系统

顺序：

- `src/plugins/loader.ts`
- `src/plugins/discovery.ts`
- `src/plugins/registry.ts`
- `src/plugins/runtime.ts`
- `src/plugins/services.ts`
- `src/channels/plugins/index.ts`
- `src/channels/plugins/outbound/load.ts`

重点问题：

- 插件是如何被发现、加载、注册到全局运行时的
- channel、tool、service、HTTP route、CLI command 是怎么插件化的
- 为什么运行期通过 active registry 去取 channel/outbound adapter

### 9. 看 channel 抽象，再挑一个具体 channel 深挖

顺序：

- 先读 `src/channels/*`
- 再选一个具体渠道，比如 `src/telegram/*`

重点问题：

- 共性策略有哪些是放在 channel 抽象层的
- 具体 channel 在哪里处理 debounce、消息解析、group policy、thread/session 绑定
- 入站与出站的边界如何划分

推荐先看 Telegram，因为它的实现最能代表完整链路。

### 10. 如果关心移动端/节点能力，再看 node 子系统

顺序：

- `src/gateway/node-registry.ts`
- `src/gateway/server-methods/nodes.ts`
- `src/gateway/server-node-events.ts`
- `src/node-host/*`
- `src/pairing/*`
- `src/infra/device-pairing.ts`

重点问题：

- 节点如何配对、注册、订阅 session
- Gateway 如何对节点下发 `node.invoke`
- 节点事件如何回流成 system event、chat event、heartbeat wake

### 11. 最后再读横切基础设施

顺序建议：

- `src/config/*`
- `src/secrets/*`
- `src/security/*`
- `src/infra/*`
- `src/process/*`
- `src/media/*`
- `src/media-understanding/*`
- `src/memory/*`
- `src/logging/*`

重点问题：

- 这些模块分别提供什么横切能力
- 哪些是框架级基础设施，哪些是 agent 能力增强
- 哪些属于“动态运行时状态”，哪些只是纯工具层

## 最小高收益阅读路线

如果你想先用最少时间抓住骨架，建议先只读这 6 个点：

1. `src/entry.ts`
2. `src/cli/run-main.ts`
3. `src/gateway/server.impl.ts`
4. `src/auto-reply/reply/get-reply.ts`
5. `src/commands/agent.ts`
6. `src/routing/resolve-route.ts`

这 6 个文件串起来后，OpenClaw 的骨架就基本建立起来了。

## 阅读方法建议

每读一个核心文件，顺手做这 4 件事：

1. 先写一句话总结这个文件的职责。
2. 记下它依赖了哪几个上游模块。
3. 记下它把结果交给了哪几个下游模块。
4. 同时配套读同目录下的测试，确认设计意图和边界条件。

很多真实设计意图不只写在实现里，也写在测试里。

## 推荐阅读节奏

建议按下面节奏推进：

- 第 1 轮：只看主干，建立全局图
- 第 2 轮：只追一条真实链路，打通消息生命周期
- 第 3 轮：补横切模块，理解配置、安全、插件、节点
- 第 4 轮：再回头看具体 channel / feature 的实现细节

不要一开始就从 `infra/`、`security/`、`media/` 这种横切目录开始，否则很容易丢掉主线。
