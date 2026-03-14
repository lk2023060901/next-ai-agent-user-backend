# Go + TS 平台编码规范

## 1. 目标

这份规范专门约束 `next-ai-agent-user-backend` 的后续改造方式。

它要解决的不是代码风格好不好看，而是以下 4 件事：

- 保证 Go 平台壳和 TS 推理核的边界长期稳定
- 保证每个模块都以组件化、模块化方式实现
- 保证模块之间只能通过公开 API 交互，不相互污染代码
- 保证任何进入主路径的模块都不是硬编码、空实现或简化版实现

## 2. 总原则

### 2.1 组件化

每个能力必须落实到独立组件，而不是散落在 handler、脚本、工具函数里。

一个合格组件必须有：

- 清晰职责
- 清晰输入输出
- 清晰初始化方式
- 清晰依赖
- 清晰测试边界

典型组件包括：

- session router
- delivery engine
- provider runtime
- transcript store
- channel runtime
- scheduler
- plugin registry

### 2.2 模块化

模块是边界，不是目录美化。

每个模块必须定义：

- owner
- public API
- internal implementation
- allowed dependencies
- forbidden dependencies

不允许：

- 模块之间共享内部状态
- 跨模块 import 私有实现
- 通过全局单例绕过模块 API

### 2.3 契约优先

模块之间的交互必须先有契约，再有实现。

契约包括：

- Go interface
- TS interface / exported contract
- protobuf service / message
- DTO / response envelope
- event envelope

### 2.4 Owner 固定

后续实现必须长期满足：

- Go 负责 control-plane、routing、transport、delivery、scheduler、operator API
- TS 负责 dialogue、provider/model、semantic transcript、tool/runtime orchestration
- provider/model 不得在 Go 出现业务实现
- channel transport / delivery transport 不得在 TS 出现业务实现

### 2.5 TS Runtime 必须基于三层 substrate

TS 侧不允许继续维持 “`pi-ai + custom core runtime`” 的形态。

必须建立在：

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

之上。

这意味着：

- 不得长期自研替代 `pi-agent-core` 的主 loop
- 不得长期自研替代 `pi-coding-agent` 的 AgentSession / SessionManager 主壳
- 本地代码只能做 adapter、policy、orchestration、event projection、platform delta

## 3. 严格禁止事项

### 3.1 禁止硬编码

不允许硬编码以下内容：

- provider/model 路由分支
- channel target 规则
- workspace/org/tenant 特殊值
- host、port、URL、token、路径
- retry / timeout / queue / fallback 策略
- magic enum / magic status / magic IDs

允许的常量必须进入：

- config schema
- policy module
- contract module
- explicit constants module

### 3.2 禁止空实现

不允许进入主路径的内容包括：

- 只返回 `[]` / `{}` / `null` 的 service
- 吞错后假成功
- 假 sender
- 假 queue
- 假 transcript store
- 只打日志不真正执行逻辑
- 只写 TODO 不给失败语义

若能力尚未实现，只允许：

- 明确返回 `not_implemented`
- 挂 feature flag 且默认关闭
- 与主路径隔离

### 3.3 禁止简化版实现长期留存

不允许把阉割版能力伪装成正式实现。

典型禁止场景：

- “临时版 session router” 只支持单实例，却直接占据正式接口
- “简化版 delivery” 不做 retry / DLQ，却接入正式路径
- “轻量版 runtime” 绕过三层 substrate，却作为未来主形态

过渡实现存在的前提是：

- 明确标注 stage
- 有替换计划
- 不伪装成最终版

### 3.4 禁止跨模块污染

不允许：

- `gateway` 直接 import `runtime` 内部实现文件
- `runtime` 直接 import `gateway` transport/runtime 组件
- `service` 跨进 session 热路径内部状态
- handler 直接访问别的模块 store/internal helper
- 通过 `any`、反射、动态字段打穿边界

## 4. 模块边界规范

### 4.1 只能通过公开 API 交互

模块之间的交互方式只能是：

- public interface
- public service contract
- protobuf RPC
- event contract
- typed DTO

不允许通过：

- 深层路径 import 内部 helper
- 共享内部对象引用
- 共享可变状态对象
- 未声明的临时函数导出

### 4.2 内部实现必须可替换

每个核心模块都要接口化。

例如：

- `SessionRouter` interface
- `DeliveryEngine` interface
- `TranscriptStore` interface
- `ProviderRuntime` interface
- `ChannelRuntime` interface

实现可以替换，但 public API 不能漂移。

### 4.3 依赖方向必须单向

推荐方向：

- edge -> app -> domain -> store/adapter
- controller -> service -> policy -> persistence

不允许反向依赖：

- store import handler
- provider adapter import HTTP edge
- channel runtime import frontend DTO layer

## 5. Go 编码规范

## 5.1 Go 目录结构

每个 Go 服务建议固定分层：

- `cmd/`
- `internal/edge/`
- `internal/app/`
- `internal/domain/`
- `internal/store/`
- `internal/adapters/`
- `internal/contracts/`

### 5.2 Go 组件先接口后实现

以下组件必须先定义 interface，再写实现：

- session router
- delivery engine
- channel registry
- config store
- event broadcaster
- node registry
- scheduler backend
- auth service

### 5.3 Go 依赖注入

必须使用：

- constructor injection
- option struct
- explicit wiring module

不允许：

- 包级业务依赖单例
- `init()` 偷偷建 client/store
- handler 里自己 new store / grpc client / publisher

### 5.4 Go handler 约束

handler 只允许做：

- parse request
- validate input
- check auth
- invoke app service
- map response

不允许在 handler 中：

- 拼业务状态机
- 直接写数据库
- 直接做 provider/model 逻辑
- 直接做 fallback / retry / routing 规则

### 5.5 Go 错误处理

必须：

- 显式返回错误
- 保留上下文
- 归一到平台错误码
- 明确 retryable 与否

不允许：

- `panic` 驱动业务流
- 记录日志后继续成功返回
- 把底层原始错误直接暴露给前端

## 6. TS 编码规范

## 6.1 TS 目录结构

每个 TS 服务建议固定分层：

- `src/contracts/`
- `src/app/`
- `src/domain/`
- `src/runtime/`
- `src/providers/`
- `src/stores/`
- `src/adapters/`
- `src/plugins/`

### 6.2 TS 只在 reasoning plane 内做编排

TS 允许做：

- reply-engine
- agent-runtime
- provider-runtime
- transcript/session semantic layer
- memory/workflow/tool orchestration

TS 不允许做：

- channel transport runtime
- final delivery transport retry/DLQ
- operator/public API edge
- node/device/browser control-plane 主逻辑

### 6.3 TS 类型要求

必须：

- 显式类型
- DTO 与 domain types 分离
- event payload 枚举化
- 避免 `any`
- 核心 contract 不得长期依赖裸对象拼接

不允许：

- `as any` 打穿边界
- 用动态字段扩展核心运行对象
- 把 provider/channel 内部对象泄漏给别的模块

### 6.4 TS 模块 API 规范

每个 TS 模块对外只暴露：

- interface
- typed factory
- typed service
- typed contract

不允许：

- 模块之间深层 import 内部 helper
- 共享未声明的 mutable state
- 靠 side effect 完成模块装配

### 6.5 TS substrate 适配规范

由于 runtime 必须站在：

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

之上，因此 TS 侧必须遵守：

- 上游 substrate 是主实现
- 本地代码是 adapter / policy / delta
- 不得把 custom loop / custom session shell 重新扶正为主实现

## 7. API 与契约规范

### 7.1 先定义 API，再写模块

任何模块上线前，必须先定义：

- public interface
- request/response contract
- error model
- event model

### 7.2 模块不得共享内部对象

跨模块传递时，必须转成 contract object。

不允许直接共享：

- ORM entity
- provider SDK object
- channel runtime internal state
- mutable session internals

### 7.3 版本与兼容

所有对外 contract 必须：

- 只追加字段
- 不复用废弃字段语义
- 有 deprecate 策略
- 有兼容测试

## 8. 配置与策略规范

### 8.1 策略必须集中化

以下策略必须进入专门模块：

- timeout policy
- retry policy
- queue policy
- fallback policy
- auth policy
- rate-limit policy
- retention policy

不允许散落在 handler、controller、tool 或 sender 中。

### 8.2 配置必须有 schema

所有配置必须：

- 有 schema
- 有默认值来源
- 有环境覆盖规则
- 有非法值报错

不允许：

- 到处 `env || default`
- handler 内直接从环境变量驱动业务逻辑

## 9. 测试规范

### 9.1 每个模块完成后必须有单元测试

这是强制要求，不是建议。

每个模块合并前，至少必须具备：

- 模块级单元测试
- public API 行为测试
- 错误路径测试
- 边界条件测试

### 9.2 核心模块必须有契约测试

必须覆盖：

- session router
- delivery engine
- provider adapter
- transcript/session stores
- event projection
- plugin registration
- scheduler
- public API contracts

### 9.3 禁止用手工联调替代测试

不允许：

- “本地能跑就算完成”
- 只测 happy path
- 用前端联调代替后端单元测试
- 过渡实现没有退出测试

## 10. API 文档规范

### 10.1 每个模块完成后必须带 API 文档

只要模块对外暴露 API，就必须同步提供文档。

API 文档至少包含：

- 模块名称与职责
- 暴露接口列表
- 请求参数
- 返回结构
- 错误码
- 事件流说明
- 权限要求
- 依赖模块

### 10.2 API 文档必须带使用示例

每个对外 API 都必须提供最少一组使用示例。

示例应覆盖：

- 标准成功请求
- 失败请求
- 可选参数示例
- 对于流式接口，给出订阅示例

### 10.3 文档必须随模块演进同步更新

不允许：

- 代码改了，文档不改
- API 已变，示例还是旧的
- 只写接口名，不写参数和示例

## 11. 模块完成定义（Definition of Done）

任何模块要被视为“完成”，必须同时满足：

1. 有清晰 public API
2. 只通过 API 与外部交互
3. 没有硬编码策略
4. 没有空实现或简化版实现混入主路径
5. 有单元测试
6. 有契约/API 测试（如适用）
7. 有 API 文档
8. 有使用示例
9. 有错误码与边界行为说明
10. 没有跨模块污染

缺任意一项，都不应视为完成。

## 12. 评审准入标准

任何实现如果违反以下任一条，都不应通过：

1. 模块没有 public API 就被调用
2. 通过硬编码写死策略
3. 用空实现或简化实现混进正式路径
4. Go 出现 provider/model 执行逻辑
5. TS 出现 channel transport / delivery 主逻辑
6. 直接 import 别的模块内部实现
7. 模块没有单元测试
8. 模块没有 API 文档
9. 对外 API 没有使用示例
10. 代码和文档不同步

## 13. 最终结论

这次改造的编码规范可以压缩成一句话：

- **组件化、模块化、契约优先、owner 固定、禁止硬编码、禁止空实现、禁止简化版实现、禁止跨模块污染、模块完成必须带单元测试与 API 文档及使用示例**

如果后续实现不满足这几条，就算“功能能跑”，也不能视为符合这次 Go + TS 平台改造目标。
