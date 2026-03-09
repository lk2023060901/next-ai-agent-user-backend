import type { Message } from "../providers/adapter.js";
import type { MessageHistory } from "./agent-types.js";

/**
 * In-memory message history.
 *
 * Stores messages sequentially. getRecent() returns a tail slice
 * without mutating the underlying array. Token-aware truncation
 * will be added when the context/ module is built.
 */
export class DefaultMessageHistory implements MessageHistory {
  private messages: Message[] = [];

  get length(): number {
    return this.messages.length;
  }

  append(message: Message): void {
    this.messages.push(message);
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
  }
}
