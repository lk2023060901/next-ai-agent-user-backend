// ─── Agent Module ───────────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the AgentLoop:
//    Implement the AgentLoop interface — controls how turns execute
//
// 2. Replace the SessionManager:
//    Implement the SessionManager interface — controls session lifecycle
//
// 3. Replace MessageHistory:
//    Implement the MessageHistory interface — controls message storage
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  AgentSession,
  SessionStatus,
  CreateSessionParams,
  SessionSummary,
  SessionManager,
  SessionStore,
  SessionRecord,
  RunStatus,
  RunUsage,
  RunResult,
  RunContext,
  ExecuteRunParams,
  AgentLoop,
  AgentLoopParams,
  AgentConfig,
  MessageHistory,
  SubAgentSpawnParams,
  SubAgentResult,
} from "./agent-types.js";

// ─── Default implementations ────────────────────────────────────────────────

export {
  DefaultAgentLoop,
  type DefaultAgentLoopOptions,
} from "./agent-loop.impl.js";

export { DefaultAgentSession } from "./agent-session.impl.js";

export {
  DefaultSessionManager,
  type DefaultSessionManagerOptions,
  type SessionFactory,
} from "./session-manager.impl.js";

export { DefaultMessageHistory } from "./message-history.js";

export { PersistentMessageHistory } from "./persistent-message-history.js";

export { SubAgentSpawner } from "./sub-agent-spawner.js";
