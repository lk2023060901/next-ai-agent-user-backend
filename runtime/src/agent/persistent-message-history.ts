import type { Message } from "../providers/adapter.js";
import type { MessageHistory, SessionStore } from "./agent-types.js";

const pendingWrites = new Set<Promise<void>>();

function trackPendingWrite(write: Promise<void>): Promise<void> {
  pendingWrites.add(write);
  void write.finally(() => {
    pendingWrites.delete(write);
  });
  return write;
}

export async function flushAllPersistentMessageHistoryWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}

// ─── Persistent Message History ─────────────────────────────────────────────
//
// Write-through cache: keeps an in-memory array for fast reads, persists
// every append to the SessionStore. On load(), hydrates from the store.
//
// H7: Critical paths (append, replaceAll) now await persistence to prevent
// data loss on crash. The sync append() still exists for interface compat
// but callers should prefer appendAsync() for the critical message path.

export class PersistentMessageHistory implements MessageHistory {
  private messages: Message[] = [];
  private readonly sessionId: string;
  private readonly store: SessionStore;
  private loaded = false;

  constructor(sessionId: string, store: SessionStore) {
    this.sessionId = sessionId;
    this.store = store;
  }

  /** Hydrate from persistent store. Call once before first use. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.messages = await this.store.getMessages(this.sessionId);
    this.loaded = true;
  }

  get length(): number {
    return this.messages.length;
  }

  /** Sync append — updates in-memory array and fires persistence without waiting.
   *  Kept for backward compat with MessageHistory interface. */
  append(message: Message): void {
    this.messages.push(message);
    trackPendingWrite(this.store.appendMessage(this.sessionId, message));
  }

  /** H7: Async append — awaits persistence to guarantee crash safety. */
  async appendAsync(message: Message): Promise<void> {
    this.messages.push(message);
    await this.store.appendMessage(this.sessionId, message);
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  getRecent(maxMessages?: number): Message[] {
    if (maxMessages === undefined || maxMessages >= this.messages.length) {
      return [...this.messages];
    }
    return this.messages.slice(-maxMessages);
  }

  clear(): void {
    this.messages = [];
    trackPendingWrite(this.store.clearMessages(this.sessionId));
  }

  async clearAsync(): Promise<void> {
    this.messages = [];
    await this.store.clearMessages(this.sessionId);
  }

  /**
   * Replace all messages with a new set (used after compaction).
   * Uses atomic replaceMessages for data integrity.
   */
  replaceAll(messages: Message[]): void {
    this.messages = [...messages];
    trackPendingWrite(this.replaceAllAsync(messages));
  }

  /** H7: Async replaceAll — awaits full persistence for crash safety. */
  async replaceAllAsync(messages: Message[]): Promise<void> {
    this.messages = [...messages];
    await this.store.replaceMessages(this.sessionId, messages);
  }
}
