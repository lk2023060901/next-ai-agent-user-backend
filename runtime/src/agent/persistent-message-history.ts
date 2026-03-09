import type { Message } from "../providers/adapter.js";
import type { MessageHistory, SessionStore } from "./agent-types.js";

// ─── Persistent Message History ─────────────────────────────────────────────
//
// Write-through cache: keeps an in-memory array for fast reads, persists
// every append to the SessionStore. On load(), hydrates from the store.
//
// append() is synchronous (per MessageHistory interface) so DB writes
// are fire-and-forget. SQLite WAL writes are ~microseconds, so the
// risk of data loss is minimal. The in-memory copy is the source of
// truth for the current process lifetime.

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

  append(message: Message): void {
    this.messages.push(message);
    // Fire-and-forget persistence
    void this.store.appendMessage(this.sessionId, message);
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
    void this.store.clearMessages(this.sessionId);
  }
}
