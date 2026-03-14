# OpenClaw 扩展体系在 Go + TS 平台中的分治策略

## 1. 目标

前面对 OpenClaw 的扩展体系已经拆清楚了：它不是一类插件，而是很多类插件共用一套 registry/hook/manifest 体系。

因此在新平台里，插件不能再继续用一个 SDK 混着做所有事。

必须拆成：

- Go 插件体系
- TS 插件体系
- 共享 manifest / contract

## 2. 基本原则

### 2.1 先按 owner 分，再按实现语言分

真正的决定因素不是“插件现在是 TS 写的”，而是它的 owner 属于谁。

- transport/control-plane owner -> Go
- provider/model/dialogue/tool owner -> TS

### 2.2 不允许跨 owner 插件

不允许存在一种插件：

- 既注册 channel transport
- 又直接操作 provider/model/fallback

这种插件在新平台里必须拆成两半。

## 3. 基于现有 OpenClaw 扩展的分类

## 3.1 应迁到 Go 的扩展类别

### A. channel transport 插件

这类插件属于 Go：

- `bluebubbles`
- `feishu`
- `googlechat`
- `irc`
- `line`
- `matrix`
- `mattermost`
- `msteams`
- `nextcloud-talk`
- `nostr`
- `synology-chat`
- `tlon`
- `twitch`
- `zalo`
- `zalouser`
- 以及内建镜像 wrapper：`telegram` `slack` `discord` `signal` `imessage` `whatsapp`

理由：

- 它们的主价值是 ingress/runtime/outbound transport
- 它们天然属于高并发连接面

### B. platform control / service-control 插件

也应迁到 Go：

- `device-pair`
- `phone-control`
- `thread-ownership`
- `voice-call` 中偏 control/runtime 的部分
- `diagnostics-otel` 中平台观测接入部分

理由：

- 它们属于 operator / runtime / control-plane 边界

## 3.2 应保留在 TS 的扩展类别

### A. provider-auth / provider bridge

这类必须在 TS：

- `copilot-proxy`
- `qwen-portal-auth`
- `minimax-portal-auth`
- `google-gemini-cli-auth`

理由：

- 它们直接碰 provider auth、provider registration、model/runtime side config

### B. memory / workflow / tool

这类必须在 TS：

- `memory-core`
- `memory-lancedb`
- `llm-task`
- `lobster`
- `diffs`
- `acpx`

理由：

- 它们直接依赖 semantic turn、provider、tool loop、runtime artifacts

### C. skills-first / semantic extensions

- `open-prose`
- 以及未来的 context-engine / skills-only 扩展

也应留在 TS。

## 3.3 Support 包

- `shared`
- `test-utils`

它们不应被当作运行时插件 owner，只能作为开发支持或共享工具包存在。

## 4. 双 SDK 设计

## 4.1 `plugin-sdk-go`

只允许提供这些槽位：

- channel ingress runtime
- channel outbound adapter
- channel login / pairing / reconnect
- platform control handlers
- node/browser/canvas integration
- monitoring exporters
- scheduler trigger adapters

不允许提供：

- provider auth logic
- model catalog logic
- fallback logic
- prompt manipulation
- semantic transcript mutation

## 4.2 `plugin-sdk-ts`

只允许提供这些槽位：

- provider auth / provider bridge
- memory backend
- tool/workflow
- semantic hooks
- context engines
- ACP / runtime bridge
- transcript preprocess / postprocess

不允许提供：

- channel transport runtime
- final delivery transport send
- operator control-plane API surface

## 4.3 共享 manifest

建议 manifest 保留一份共享 schema，但要带明确 owner 声明：

- `owner: go | ts`
- `kind: channel | provider | memory | workflow | service | control | support`
- `capabilities[]`
- `requires[]`
- `publicApiSlots[]`
- `internalEventSlots[]`

这样平台在装载时就能拒绝越权插件。

## 5. Hook Bus 的分治

前面对 OpenClaw 的结论已经很明确：

- typed plugin hooks
- internal hooks

在新平台里也要拆开，但更重要的是拆 owner。

### Go hooks

负责：

- channel ingress lifecycle
- outbound delivery hooks
- node/device/browser/canvas hooks
- scheduler/platform hooks
- monitoring hooks

### TS hooks

负责：

- prompt/turn hooks
- provider hooks
- tool hooks
- transcript hooks
- memory hooks

不允许：

- Go hook 直接改 semantic transcript
- TS hook 直接改 channel transport send 行为

## 6. 迁移策略

### 6.1 第一批迁移

先做 owner 最清晰的：

- provider-auth -> TS SDK
- memory/workflow -> TS SDK
- runtime-heavy channels -> Go SDK

### 6.2 第二批迁移

再迁边界更复杂的：

- thread-ownership
- voice-call
- diagnostics-otel
- phone-control

### 6.3 需要拆分的扩展

某些扩展可能需要一拆为二，例如：

- 一个部分留在 Go，负责 transport/control
- 一个部分留在 TS，负责 semantic/runtime

这类扩展不应强行维持单插件形态。

## 7. 与目标 backend 仓库的目录对齐

### Go 侧建议目录

- `gateway/plugins/go-sdk/*`
- `gateway/plugins/runtime/*`
- `gateway/plugins/control/*`

### TS 侧建议目录

- `runtime/plugins/ts-sdk/*`
- `runtime/plugins/provider/*`
- `runtime/plugins/memory/*`
- `runtime/plugins/workflow/*`

### `service/` 侧

原则上不应成为插件主战场。

如果保留插件查询或管理能力，只能做：

- manifest catalog
- install status
- permission/policy metadata

## 8. 插件安装与安全策略

建议：

- 安装面在 Go 控制平面
- runtime 装载按 owner 分发到 Go 或 TS
- manifest 校验时直接拒绝越权声明
- 插件权限模型区分：
  - `channel_runtime`
  - `delivery_transport`
  - `provider_auth`
  - `semantic_tool`
  - `platform_control`

## 9. 结论

OpenClaw 原来的扩展体系很强，但它之所以强，是因为在一个厚单体里共享了很多运行时上下文。

到了 Go + TS 平台里，不能继续用“一个 SDK 全包”的方式延续这种强大，否则边界会重新塌掉。

正确做法是：

- transport/control -> Go
- provider/tool/memory/semantic -> TS
- manifest 共享
- SDK 分治

这不是削弱扩展体系，而是让扩展体系真正继承平台 owner 规则。
