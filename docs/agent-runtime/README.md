# Agent Runtime Docs

## Current Reading Order

建议按下面顺序阅读：

1. [05-agent-runtime-architecture.md](./05-agent-runtime-architecture.md)
2. [08-execution-semantics.md](./08-execution-semantics.md)
3. [07-deep-review-round2.md](./07-deep-review-round2.md)
4. [06-implementation-plan.md](./06-implementation-plan.md)

## File Roles

- `05-agent-runtime-architecture.md`
  - 运行时分层、核心模块、主链架构设计
- `08-execution-semantics.md`
  - 当前有效的串行执行约束
  - 新增链路时优先参考这份
- `07-deep-review-round2.md`
  - Round 2 端到端链路审计的复核闭环记录
  - 用于确认哪些历史问题已经落地修复
- `06-implementation-plan.md`
  - 早期实现计划归档
  - 不再作为待办清单维护

## Current Status

截至 2026-03-16：

- `06` 中的实现计划已完成或确认无需修改
- `07` 中的审计条目已完成复核并同步状态
- `08` 是当前运行时约束的基准文档

后续如果继续扩展 runtime：

- 先更新 `08`
- 再补实现与测试
- 最后在 `07` 或新复盘文档中记录复核结论
