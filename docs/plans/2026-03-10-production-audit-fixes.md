# 生产上线审计修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标:** 修复生产审计中发现的所有阻断级和高危问题，使平台达到可上线状态。

**审计日期:** 2026-03-10
**问题统计:** 6 Blocker / 7 High / 13 Medium / 9 Low

**技术栈:** Go (chi), TypeScript (Fastify + gRPC + Drizzle), Next.js 15, SQLite

---

## 修复优先级总览

| Phase | 范围 | 严重性 | 任务数 | 预计工时 |
|-------|------|--------|--------|----------|
| Phase 1 | 鉴权与密钥修复 | Blocker | 5 | 4h |
| Phase 2 | 网关安全加固 | High | 5 | 3h |
| Phase 3 | 数据模型修复 | Medium | 4 | 2h |
| Phase 4 | 运行时加固 | High+Medium | 6 | 4h |
| Phase 5 | 部署基础设施 | Blocker | 3 | 4h |
| Phase 6 | 核心测试覆盖 | Blocker | 4 | 6h |

---

## Phase 1: 鉴权与密钥修复 (Blocker)

### Task 1.1: Session/Chat 操作添加鉴权 (B2)

**问题:** `updateSession`, `deleteSession`, `listMessages`, `saveUserMessage`, `updateUserMessage` 五个 gRPC handler 不校验用户归属。

**文件:** `service/src/grpc/server.ts` (行 1097-1143)

**步骤:**

1. 在 `service/src/modules/chat/chat.service.ts` 中添加 `assertSessionOwner(sessionId: string, userId: string)` 函数：
   - 查询 session 所属 workspace
   - 调用 `assertWorkspaceMember(workspaceId, userId)` 校验
   - session 不存在时 throw `{ code: 'NOT_FOUND' }`

2. 在 `service/src/grpc/server.ts` 中修改以下 5 个 handler，在业务逻辑前插入鉴权调用：

   ```typescript
   // updateSession (行 1097)
   updateSession(call, callback) {
     try {
       assertSessionOwner(call.request.sessionId, call.request.userContext?.userId);  // 新增
       callback(null, updateSession({ ... }));
     } catch (err) { handleError(callback, err); }
   }
   ```

   对 `deleteSession`, `listMessages`, `saveUserMessage`, `updateUserMessage` 执行相同操作。

3. 验证：确认 `createSession` (行 1090) 已有 `assertWorkspaceMember` — 仅需补齐其余 5 个。

**验收标准:** 无有效 `userContext.userId` 的请求返回 gRPC `PERMISSION_DENIED`。

---

### Task 1.2: Channel 操作添加鉴权 (B3)

**问题:** `handleWebhook`, `listChannelMessages`, `sendChannelMessage` 三个 gRPC handler 无鉴权。

**文件:** `service/src/grpc/server.ts` (行 799-833)

**步骤:**

1. `handleWebhook` (行 799): 此为外部调用，不能要求 userId。改为在 channel.service.ts 中验证 webhook 签名（每种渠道类型有不同签名机制）。如果暂时无法实现完整签名验证，至少校验 channelId 存在且 channel 状态为 `active`：
   ```typescript
   handleWebhook(call, callback) {
     try {
       assertChannelExists(call.request.channelId);  // 新增: 校验 channel 存在且 active
       const result = handleWebhook(...);
       callback(null, result);
     } catch (err) { handleError(callback, err); }
   }
   ```

2. `listChannelMessages` (行 805): 添加 `assertChannelMember` 校验：
   ```typescript
   listChannelMessages(call, callback) {
     try {
       assertChannelMember(call.request.channelId, call.request.userContext?.userId);  // 新增
       callback(null, { messages: listChannelMessages(...) });
     } catch (err) { handleError(callback, err); }
   }
   ```

3. `sendChannelMessage` (行 823): 此为运行时内部调用。在 service 层校验 channelId 存在：
   ```typescript
   async sendChannelMessage(call, callback) {
     try {
       assertChannelExists(call.request.channelId);  // 新增
       await sendChannelMessage({ ... });
       callback(null, {});
     } catch (err) { handleError(callback, err); }
   }
   ```

4. 在 `channel.service.ts` 中实现 `assertChannelExists(channelId)`: 查询 channels 表，不存在则 throw `{ code: 'NOT_FOUND' }`。

**验收标准:** 不存在的 channelId 返回 NOT_FOUND；listChannelMessages 要求有效的用户身份。

---

### Task 1.3: Scheduler Task 操作添加鉴权 (H6)

**问题:** `updateTask` 和 `deleteTask` 缺少 `assertWorkspaceMember` 调用。

**文件:** `service/src/grpc/server.ts` (行 872-889)

**步骤:**

1. `updateTask` (行 872): 需要先通过 taskId 查找对应 workspaceId，然后校验：
   ```typescript
   updateTask(call, callback) {
     try {
       const task = getTask(call.request.taskId);  // 取出 task 获取 workspaceId
       assertWorkspaceMember(task.workspaceId, call.request.userContext?.userId);  // 新增
       callback(null, updateTask(call.request.taskId, { ... }));
     } catch (err) { handleError(callback, err); }
   }
   ```

2. `deleteTask` (行 886): 同理。

3. 如果 scheduler.service.ts 中没有 `getTask()` 函数，需要新增一个通过 taskId 查询 task 记录的函数。

**验收标准:** 非 workspace 成员无法修改或删除定时任务。

---

### Task 1.4: 密钥时序安全比较 (B4)

**问题:** `X-Runtime-Secret` 使用普通字符串比较，易受时序攻击。

**文件:**
- `gateway/internal/middleware/auth.go` (行 89)
- `runtime/src/main.ts` (行 178)
- `gateway/internal/handler/channels.go` (搜索 `X-Runtime-Secret`)
- `runtime/src/main.ts` 中所有 `runtimeSecret` 比较点

**步骤:**

1. **Go 网关** — `gateway/internal/middleware/auth.go:89`:
   ```go
   import "crypto/subtle"

   // 替换:
   // if secret == runtimeSecret {
   // 为:
   if subtle.ConstantTimeCompare([]byte(secret), []byte(runtimeSecret)) == 1 {
   ```

2. **Go 网关** — `gateway/internal/handler/channels.go` 中所有 `X-Runtime-Secret` 比较点，同样替换。

3. **Go 网关** — `gateway/internal/handler/runtime_tools.go` 中同样替换。

4. **TS 运行时** — `runtime/src/main.ts` 中所有 secret 比较点：
   ```typescript
   import { timingSafeEqual } from 'node:crypto';

   function safeCompare(a: string, b: string): boolean {
     if (a.length !== b.length) return false;
     return timingSafeEqual(Buffer.from(a), Buffer.from(b));
   }

   // 替换所有:
   // if (providedSecret !== config.runtimeSecret) {
   // 为:
   // if (!safeCompare(providedSecret, config.runtimeSecret)) {
   ```

5. 将 `safeCompare` 提取到 `runtime/src/utils/crypto.ts`（如果不存在则创建）以便复用。

**验收标准:** 所有 runtime secret 比较使用常量时间算法。`grep -rn '== .*runtimeSecret\|!== .*runtimeSecret\|runtimeSecret ==' gateway/ runtime/src/` 应无匹配。

---

### Task 1.5: 生产环境拒绝默认密钥 (B5)

**问题:** 三个服务均接受硬编码开发密钥作为默认值。

**文件:**
- `gateway/internal/config/config.go` (行 50-58)
- `service/src/config.ts` (行 4, 9, 10)
- `runtime/src/config.ts` (行 17)

**步骤:**

1. **Go 网关** — `gateway/internal/config/config.go`: 将 `Validate()` 的警告改为在 `main.go` 中致命错误：
   ```go
   // cmd/gateway/main.go 中替换:
   // for _, warning := range cfg.Validate() {
   //     log.Printf("WARNING: %s", warning)
   // }
   // 为:
   warnings := cfg.Validate()
   if os.Getenv("GO_ENV") == "production" && len(warnings) > 0 {
       for _, w := range warnings {
           log.Printf("FATAL: %s", w)
       }
       log.Fatalf("Cannot start with insecure defaults in production mode. Set GO_ENV to something other than 'production' for development.")
   }
   for _, w := range warnings {
       log.Printf("WARNING: %s", w)
   }
   ```

2. **TS 服务** — `service/src/server.ts` (启动时): 在 Fastify listen 之前添加校验：
   ```typescript
   if (process.env.NODE_ENV === 'production') {
     const insecure = [
       config.jwtSecret === 'dev-secret-change-in-production' && 'JWT_SECRET',
       config.runtimeSecret === 'dev-runtime-secret' && 'RUNTIME_SECRET',
       config.encryptionSecret === 'dev-secret-change-in-production' && 'ENCRYPTION_SECRET',
     ].filter(Boolean);
     if (insecure.length > 0) {
       console.error(`FATAL: Insecure defaults detected for: ${insecure.join(', ')}. Cannot start in production.`);
       process.exit(1);
     }
   }
   ```

3. **TS 运行时** — `runtime/src/main.ts` (启动时): 同理校验 `config.runtimeSecret`:
   ```typescript
   if (process.env.NODE_ENV === 'production' && config.runtimeSecret === 'dev-runtime-secret') {
     console.error('FATAL: RUNTIME_SECRET must be set in production.');
     process.exit(1);
   }
   ```

**验收标准:** `NODE_ENV=production` + 默认密钥 → 服务拒绝启动。`NODE_ENV=development`（或未设置） → 保持当前行为（警告但继续）。

---

## Phase 2: 网关安全加固 (High)

### Task 2.1: Bifrost 代理剥离敏感请求头 (H2)

**文件:** `gateway/internal/stream/bifrost_proxy.go`

**步骤:**

1. 添加 `ModifyRequest` 钩子剥离敏感头：
   ```go
   func BifrostProxy(bifrostAddr string) http.Handler {
       target, err := url.Parse(bifrostAddr)
       if err != nil {
           log.Fatalf("invalid bifrost addr: %s", bifrostAddr)  // 同时修复 L6: panic → Fatalf
       }
       proxy := httputil.NewSingleHostReverseProxy(target)
       originalDirector := proxy.Director
       proxy.Director = func(req *http.Request) {
           originalDirector(req)
           req.Header.Del("X-Runtime-Secret")
           req.Header.Del("Cookie")
           // 保留 Authorization — Bifrost 需要它来路由 LLM 请求
       }
       return proxy
   }
   ```

2. 同时将 `panic()` 替换为 `log.Fatalf()` 使错误在启动时优雅处理。

**验收标准:** Bifrost 不再接收 `X-Runtime-Secret` 和 `Cookie` 头。

---

### Task 2.2: 全局请求体大小限制 (H3)

**文件:** `gateway/cmd/gateway/main.go`

**步骤:**

1. 在中间件栈中（CORS 之后、路由之前）添加全局限制：
   ```go
   // 添加全局 body 大小限制 (10MB)
   r.Use(func(next http.Handler) http.Handler {
       return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
           if r.ContentLength > 10<<20 {
               http.Error(w, `{"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
               return
           }
           r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
           next.ServeHTTP(w, r)
       })
   })
   ```

2. 文件上传端点（`tools.go` 的 KB document 上传）已使用 `ParseMultipartForm(32<<20)`，此全局限制对 multipart 请求可能过严。可通过路由级覆盖解决，或将全局限制调至 50MB。

**验收标准:** 超过限制的请求返回 413。

---

### Task 2.3: gRPC 调用添加超时 (H4)

**文件:** `gateway/internal/grpcclient/client.go`

**步骤:**

1. 创建一个 helper 函数为每个请求添加超时 context:
   ```go
   // gateway/internal/handler/helpers.go 中添加:
   func withTimeout(r *http.Request, timeout time.Duration) (context.Context, context.CancelFunc) {
       return context.WithTimeout(r.Context(), timeout)
   }
   ```

2. 在所有 handler 中使用（示例 — `auth.go`）:
   ```go
   func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
       // ...
       ctx, cancel := withTimeout(r, 15*time.Second)
       defer cancel()
       resp, err := h.clients.Auth.Login(ctx, &req)
       // ...
   }
   ```

3. 为不同类型的操作设置不同超时:
   - 常规 CRUD: 15s
   - 文件上传/KB 处理: 60s
   - LLM 代理: 120s (通过 Bifrost)

4. 也可在 gRPC client 初始化时设置默认超时:
   ```go
   conn, err = grpc.NewClient(addr,
       grpc.WithTransportCredentials(insecure.NewCredentials()),
       grpc.WithDefaultCallOptions(
           grpc.MaxCallRecvMsgSize(10<<20),
       ),
   )
   ```

**验收标准:** TS 服务无响应时，网关在 15s 内返回 504 而非无限等待。

---

### Task 2.4: UserContext 提取失败处理 (H5)

**文件:** 所有网关 handler 中的 `userCtx()` 方法

**步骤:**

1. 修改 `helpers.go` 中的通用 helper (或每个 handler 的 `userCtx`)：
   ```go
   func (h *SomeHandler) userCtx(r *http.Request) (*commonpb.UserContext, error) {
       u, ok := middleware.GetUser(r)
       if !ok {
           return nil, fmt.Errorf("no user context")
       }
       return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}, nil
   }
   ```

2. 调用侧改为:
   ```go
   uc, err := h.userCtx(r)
   if err != nil {
       writeError(w, http.StatusUnauthorized, "authentication required")
       return
   }
   ```

3. 逐个 handler 文件修改: `org.go`, `chat.go`, `settings.go`, `tools.go`, `channels.go`, `workspace.go`, `plugins.go`, `scheduler.go`。

**注意:** `AuthOrRuntimeSecret` 路径中 X-Runtime-Secret 认证不设置 UserContext。对于 `/runtime/*` 代理路由这没问题（runtime 有自己的鉴权），但如果有 handler 同时在两种路径下使用，需要特殊处理。

**验收标准:** 无有效 JWT 时不再产生空 UserContext，而是返回 401。

---

### Task 2.5: 运行时端口仅绑定 localhost (H1)

**文件:** `runtime/src/main.ts`

**步骤:**

1. 修改 Fastify listen 调用，绑定 localhost:
   ```typescript
   // 替换:
   // await app.listen({ port: config.port });
   // 为:
   const host = process.env.RUNTIME_HOST ?? '127.0.0.1';
   await app.listen({ port: config.port, host });
   ```

2. 在 `runtime/src/config.ts` 中添加:
   ```typescript
   host: getEnv("RUNTIME_HOST", "127.0.0.1"),
   ```

3. 生产部署时确保网关与运行时在同一主机或通过安全网络通信。

**验收标准:** 运行时不可从外部网络直接访问。`netstat -tlnp | grep 8082` 显示绑定 `127.0.0.1:8082`。

---

## Phase 3: 数据模型修复 (Medium)

### Task 3.1: Workspace slug 唯一约束 (M1)

**文件:** `service/src/db/schema.ts`

**步骤:**

1. 在 workspaces 表定义中添加联合唯一索引:
   ```typescript
   // 在 workspaces 表的 relations/indexes 部分添加:
   (t) => ({
     // 已有的索引...
     uqOrgSlug: uniqueIndex("workspaces_org_slug_uq").on(t.orgId, t.slug),
   })
   ```

2. 运行 `npm run db:generate` 生成迁移 SQL。

3. 运行 `npm run db:migrate` 应用迁移。

4. **注意:** 如果已有重复数据，迁移会失败。先检查:
   ```sql
   SELECT orgId, slug, COUNT(*) c FROM workspaces GROUP BY orgId, slug HAVING c > 1;
   ```

**验收标准:** 相同 org 内创建同名 slug 的 workspace 返回冲突错误。

---

### Task 3.2: agentKnowledgeBases 添加外键 + 唯一约束 (M2)

**文件:** `service/src/db/schema.ts` (行 105-110)

**步骤:**

1. 为 `knowledgeBaseId` 添加外键引用:
   ```typescript
   knowledgeBaseId: text("knowledgeBaseId")
     .notNull()
     .references(() => knowledgeBases.id, { onDelete: "cascade" }),
   ```

2. 添加联合唯一约束防止重复关联:
   ```typescript
   (t) => ({
     uqAgentKb: uniqueIndex("agent_kb_uq").on(t.agentId, t.knowledgeBaseId),
   })
   ```

3. 生成并应用迁移。

**验收标准:** 删除 KB 时自动级联删除关联记录；同一 agent 不可重复关联相同 KB。

---

### Task 3.3: 添加缺失的外键索引 (M3)

**文件:** `service/src/db/schema.ts`

**步骤:**

1. 为 `knowledgeBases` 表添加 workspaceId 索引:
   ```typescript
   (t) => ({
     idxWsId: index("kb_ws_idx").on(t.workspaceId),
   })
   ```

2. 为 `aiProviders` 表添加 workspaceId 索引:
   ```typescript
   (t) => ({
     idxWsId: index("ai_providers_ws_idx").on(t.workspaceId),
   })
   ```

3. 检查其他高频查询表是否需要索引（如 `schedulerTasks.workspaceId`）。

4. 生成并应用迁移。

**验收标准:** `EXPLAIN QUERY PLAN` 对 workspace 范围查询使用索引扫描而非全表扫描。

---

### Task 3.4: 遗留 Base64 解密添加日志警告 (H7)

**文件:** `service/src/utils/crypto.ts` (行 52-56)

**步骤:**

1. 在遗留路径添加警告日志:
   ```typescript
   export function decryptSecretCompat(ciphertext: string, masterSecret: string): string {
     if (isLegacyEncrypted(ciphertext)) {
       console.warn('[crypto] Legacy Base64 decryption used — consider migrating to AES-256-GCM');
       return Buffer.from(ciphertext, "base64").toString("utf-8").trim();
     }
     return decryptSecret(ciphertext, masterSecret);
   }
   ```

2. 可选：添加一次性迁移脚本将所有 Base64 加密的 API key 重新加密为 AES-256-GCM：
   - 查询所有 `aiProviders` 中的 `apiKeyEncrypted`
   - 用 `isLegacyEncrypted()` 检测
   - 用 `decryptSecretCompat()` 解密 → `encryptSecret()` 重新加密 → 更新记录

**验收标准:** 使用遗留路径时控制台可见警告日志。

---

## Phase 4: 运行时加固 (High + Medium)

### Task 4.1: Session 锁 Map 清理 (M8)

**文件:** `runtime/src/orchestrator/session-lock.ts`

**步骤:**

1. 添加定期清理逻辑:
   ```typescript
   private cleanupInterval: ReturnType<typeof setInterval> | null = null;

   start() {
     // 每 60 秒清理无等待者的空锁链
     this.cleanupInterval = setInterval(() => {
       for (const [key, chain] of this.chains.entries()) {
         // 如果 chain 已 resolved 且无等待者，删除
         chain.then(() => {
           // 此时 chain 已完成，若仍在 map 中说明没有新的等待者
           if (this.chains.get(key) === chain) {
             this.chains.delete(key);
           }
         }).catch(() => {
           this.chains.delete(key);
         });
       }
     }, 60_000);
     this.cleanupInterval.unref();
   }

   shutdown() {
     if (this.cleanupInterval) clearInterval(this.cleanupInterval);
   }
   ```

2. 在 `orchestrator.impl.ts` 的 constructor 中调用 `sessionLock.start()`，在 `shutdown()` 中调用 `sessionLock.shutdown()`。

**验收标准:** 长时间运行后 session lock map 不会无限增长。

---

### Task 4.2: Orchestrator shutdown 添加超时 (M11)

**文件:** `runtime/src/main.ts` (shutdown 逻辑处)

**步骤:**

1. 为 orchestrator.shutdown() 添加超时:
   ```typescript
   const SHUTDOWN_TIMEOUT_MS = 30_000;

   async function gracefulShutdown(signal: string) {
     if (isShuttingDown) return;
     isShuttingDown = true;
     app.log.info(`Received ${signal}, shutting down gracefully...`);

     // 带超时的 shutdown
     const shutdownPromise = orchestrator.shutdown();
     const timeoutPromise = new Promise<void>((_, reject) =>
       setTimeout(() => reject(new Error('Shutdown timed out')), SHUTDOWN_TIMEOUT_MS)
     );

     try {
       await Promise.race([shutdownPromise, timeoutPromise]);
     } catch (err) {
       app.log.warn(`Orchestrator shutdown timeout after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
     }

     // 清理其他资源
     runStore.close();
     closeRuntimeDb();
     await app.close();
     process.exit(0);
   }
   ```

**验收标准:** 即使有 stuck run，进程也在 30s 内退出。

---

### Task 4.3: appendMessage 原子性 (M10)

**文件:** `runtime/src/db/sqlite-memory-store.ts` (appendMessage 方法)

**步骤:**

1. 将 SELECT MAX + INSERT 包装在事务中:
   ```typescript
   appendMessage(sessionId: string, message: Message): void {
     const db = this.getDb();
     const txn = db.transaction(() => {
       const row = db.prepare(
         'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM session_messages WHERE sessionId = ?'
       ).get(sessionId) as { nextSeq: number };
       db.prepare(
         'INSERT INTO session_messages (sessionId, seq, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
       ).run(sessionId, row.nextSeq, message.role, JSON.stringify(message.content), JSON.stringify(message.metadata ?? {}));
     });
     txn();
   }
   ```

2. 或者更好的方案——使用 SQLite 的 `INSERT ... SELECT`:
   ```sql
   INSERT INTO session_messages (sessionId, seq, role, content, metadata)
   SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
   FROM session_messages WHERE sessionId = ?
   ```

**验收标准:** 并发 append 不产生重复 seq 号。

---

### Task 4.4: CJK token 估算修正 (M9)

**文件:** `runtime/src/` 中的 token 估算函数（搜索 `chars` 或 `tokenEstimat`）

**步骤:**

1. 找到 token 估算函数（大概率在 `context/` 或 `utils/` 中）。

2. 对 CJK 字符使用更准确的乘数:
   ```typescript
   function estimateTokens(text: string): number {
     let tokens = 0;
     for (const char of text) {
       const code = char.codePointAt(0)!;
       // CJK Unified Ideographs + extensions + common punctuation
       if (
         (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK basic
         (code >= 0x3400 && code <= 0x4DBF) ||  // CJK ext A
         (code >= 0x3000 && code <= 0x303F) ||  // CJK symbols
         (code >= 0xFF00 && code <= 0xFFEF)     // fullwidth forms
       ) {
         tokens += 2;  // 保守估计: 每个 CJK 字符 ~1-2 token
       } else {
         tokens += 0.25;  // 英文大约 4 chars/token
       }
     }
     return Math.ceil(tokens);
   }
   ```

3. 确认估算函数被 ContextEngine 和 TokenBudget 使用。

**验收标准:** 中文长文本的 token 估算不低于实际值的 80%。

---

### Task 4.5: 错误消息清理 (M7)

**文件:** `gateway/internal/handler/helpers.go` (行 48-60)

**步骤:**

1. 修改 `writeGRPCError` 中非 gRPC 错误的处理:
   ```go
   func writeGRPCError(w http.ResponseWriter, err error) {
       st, ok := status.FromError(err)
       if !ok {
           // 不再暴露原始错误: writeError(w, 500, err.Error())
           log.Printf("Internal error: %v", err)  // 仅服务端日志
           writeError(w, http.StatusInternalServerError, "internal server error")
           return
       }
       // gRPC 状态映射保持不变...
   }
   ```

2. 确保所有 `writeError` 调用不包含 Go 内部堆栈信息。

**验收标准:** 500 错误只返回通用消息，详细错误仅出现在服务端日志。

---

### Task 4.6: Request ID 传播到 gRPC (M13)

**文件:**
- `gateway/internal/handler/helpers.go`
- `gateway/internal/middleware/auth.go`

**步骤:**

1. 在 handler helper 中提取 request ID 并传入 gRPC metadata:
   ```go
   import "google.golang.org/grpc/metadata"

   func grpcCtx(r *http.Request) context.Context {
       ctx := r.Context()
       reqID, _ := ctx.Value(middleware.RequestIDKey).(string)
       if reqID != "" {
           md := metadata.Pairs("x-request-id", reqID)
           ctx = metadata.NewOutgoingContext(ctx, md)
       }
       return ctx
   }
   ```

2. 所有 handler 使用 `grpcCtx(r)` 代替 `r.Context()` 调用 gRPC。

3. TS 服务端提取 metadata 用于日志:
   ```typescript
   const requestId = call.metadata?.get('x-request-id')?.[0] ?? '';
   ```

**验收标准:** TS 服务日志中包含与 gateway access log 对应的 request ID。

---

## Phase 5: 部署基础设施 (Blocker)

### Task 5.1: 创建 Dockerfile

**步骤:**

1. **Go 网关** — `gateway/Dockerfile`:
   ```dockerfile
   FROM golang:1.26-alpine AS builder
   WORKDIR /app
   COPY go.mod go.sum ./
   RUN go mod download
   COPY . .
   RUN CGO_ENABLED=0 go build -o /gateway ./cmd/gateway

   FROM alpine:3.19
   RUN apk add --no-cache ca-certificates
   COPY --from=builder /gateway /gateway
   ENV GO_ENV=production
   EXPOSE 8080
   CMD ["/gateway"]
   ```

2. **TS 服务** — `service/Dockerfile`:
   ```dockerfile
   FROM node:22-alpine AS builder
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build

   FROM node:22-alpine
   WORKDIR /app
   COPY --from=builder /app/dist ./dist
   COPY --from=builder /app/node_modules ./node_modules
   COPY --from=builder /app/package.json ./
   COPY proto/ /app/proto/
   ENV NODE_ENV=production
   EXPOSE 50051 3001
   CMD ["node", "dist/server.js"]
   ```

3. **TS 运行时** — `runtime/Dockerfile`:
   ```dockerfile
   FROM node:22-alpine AS builder
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build

   FROM node:22-alpine
   WORKDIR /app
   RUN apk add --no-cache python3 make g++  # better-sqlite3 native build
   COPY --from=builder /app/dist ./dist
   COPY --from=builder /app/node_modules ./node_modules
   COPY --from=builder /app/package.json ./
   COPY proto/ /app/proto/
   ENV NODE_ENV=production
   EXPOSE 8082
   CMD ["node", "dist/main.js"]
   ```

4. 注意: `better-sqlite3` 和 `sqlite-vec` 是 native 模块，Docker 中可能需要 `npm rebuild`。

**验收标准:** 每个服务可通过 `docker build` 构建并 `docker run` 启动。

---

### Task 5.2: 创建 docker-compose.yml

**文件:** `next-ai-agent-user-backend/docker-compose.yml`

**步骤:**

1. 创建开发用 docker-compose:
   ```yaml
   version: '3.8'
   services:
     gateway:
       build: ./gateway
       ports: ["8080:8080"]
       environment:
         GRPC_ADDR: service:50051
         BIFROST_ADDR: http://bifrost:8081
         RUNTIME_ADDR: http://runtime:8082
         JWT_SECRET: ${JWT_SECRET}
         RUNTIME_SECRET: ${RUNTIME_SECRET}
         FRONTEND_URL: ${FRONTEND_URL:-http://localhost:3000}
       depends_on: [service, runtime]

     service:
       build: ./service
       ports: ["50051:50051", "3001:3001"]
       volumes:
         - ./data:/app/data
       environment:
         JWT_SECRET: ${JWT_SECRET}
         RUNTIME_SECRET: ${RUNTIME_SECRET}
         DB_PATH: /app/data/app.db

     runtime:
       build: ./runtime
       ports: ["8082:8082"]
       volumes:
         - ./data:/app/data
       environment:
         GRPC_ADDR: service:50051
         GATEWAY_ADDR: http://gateway:8080
         RUNTIME_SECRET: ${RUNTIME_SECRET}
         DB_PATH: /app/data/runtime.db

   volumes:
     data:
   ```

2. 创建 `.env.example` 列出必需的环境变量。

**验收标准:** `docker-compose up` 启动完整后端栈。

---

### Task 5.3: 基础 CI 流水线

**文件:** `.github/workflows/ci.yml`（放在仓库根目录）

**步骤:**

1. 创建 GitHub Actions 工作流:
   ```yaml
   name: CI
   on: [push, pull_request]
   jobs:
     frontend:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: pnpm/action-setup@v4
           with: { version: 9 }
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: pnpm, cache-dependency-path: next-ai-agent-user-frontend/pnpm-lock.yaml }
         - run: pnpm install --frozen-lockfile
           working-directory: next-ai-agent-user-frontend
         - run: pnpm typecheck
           working-directory: next-ai-agent-user-frontend
         - run: pnpm lint
           working-directory: next-ai-agent-user-frontend
         - run: pnpm test:unit
           working-directory: next-ai-agent-user-frontend

     gateway:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-go@v5
           with: { go-version: '1.26' }
         - run: go vet ./...
           working-directory: next-ai-agent-user-backend/gateway
         - run: go build ./...
           working-directory: next-ai-agent-user-backend/gateway

     service:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22 }
         - run: npm ci
           working-directory: next-ai-agent-user-backend/service
         - run: npm run build
           working-directory: next-ai-agent-user-backend/service

     runtime:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22 }
         - run: npm ci
           working-directory: next-ai-agent-user-backend/runtime
         - run: npm run build
           working-directory: next-ai-agent-user-backend/runtime
   ```

**验收标准:** PR 和 push 时自动运行 lint + build + test。

---

## Phase 6: 核心测试覆盖 (Blocker)

### Task 6.1: 认证流程测试

**文件:** `service/src/modules/auth/__tests__/auth.service.test.ts` (新建)

**测试用例:**
1. `signup` — 成功注册返回 user + tokens
2. `signup` — 重复邮箱返回 ALREADY_EXISTS
3. `login` — 正确凭据返回 tokens
4. `login` — 错误密码返回 UNAUTHENTICATED
5. `login` — 不存在的邮箱返回 UNAUTHENTICATED
6. `refresh` — 有效 refresh token 返回新 access token
7. `refresh` — 过期/无效 refresh token 返回 UNAUTHENTICATED
8. JWT 载荷包含正确的 user_id, email, name claims

**技术:** Vitest，直接调用 service 函数，使用内存 SQLite（`:memory:`）或临时文件。

---

### Task 6.2: Session 鉴权测试

**文件:** `service/src/modules/chat/__tests__/chat.service.test.ts` (新建)

**测试用例:**
1. `createSession` — workspace 成员可创建
2. `createSession` — 非成员返回 PERMISSION_DENIED
3. `updateSession` — session 归属 workspace 的成员可更新
4. `updateSession` — 其他 workspace 成员不可更新
5. `deleteSession` — 仅归属 workspace 成员可删除
6. `listMessages` — 仅归属 workspace 成员可读取
7. `saveUserMessage` — 仅归属 workspace 成员可写入
8. `updateUserMessage` — 仅归属 workspace 成员可修改

---

### Task 6.3: Channel 鉴权测试

**文件:** `service/src/modules/channel/__tests__/channel.service.test.ts` (新建)

**测试用例:**
1. `listChannelMessages` — workspace 成员可读取
2. `listChannelMessages` — 非成员返回 PERMISSION_DENIED
3. `handleWebhook` — 有效 channelId 处理成功
4. `handleWebhook` — 不存在的 channelId 返回 NOT_FOUND
5. `sendChannelMessage` — 有效 channel 发送成功
6. `sendChannelMessage` — 不存在的 channel 返回 NOT_FOUND

---

### Task 6.4: 密钥安全测试

**文件:** `service/src/__tests__/crypto.test.ts` (新建)

**测试用例:**
1. `encryptSecret` + `decryptSecret` 往返一致
2. `decryptSecret` 对篡改的密文抛出错误
3. `isLegacyEncrypted` 正确识别旧格式
4. `decryptSecretCompat` 兼容旧 Base64 格式
5. `decryptSecretCompat` 正确处理新 AES-256-GCM 格式
6. 验证不同 masterSecret 不能解密

**Go 网关测试:** `gateway/internal/middleware/auth_test.go`:
1. 有效 JWT 通过 Auth 中间件
2. 无效/过期 JWT 返回 401
3. X-Runtime-Secret 正确时通过 AuthOrRuntimeSecret
4. X-Runtime-Secret 错误时返回 401
5. 两者都无时返回 401

---

## 完成标准

所有 Phase 完成后:

- [ ] 零 Blocker 级问题
- [ ] 零 High 级问题
- [ ] Session/Chat 5 个 handler 有鉴权
- [ ] Channel 3 个 handler 有鉴权
- [ ] Scheduler 2 个 handler 有鉴权
- [ ] 所有 secret 比较使用常量时间
- [ ] 生产模式拒绝默认密钥
- [ ] 网关有全局 body 限制 + gRPC 超时
- [ ] Bifrost 代理剥离敏感头
- [ ] 运行时绑定 localhost
- [ ] DB schema 有正确的唯一约束和索引
- [ ] Dockerfile + docker-compose 可用
- [ ] CI 流水线运行 lint + build
- [ ] 核心业务流程有测试覆盖
