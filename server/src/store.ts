import { randomUUID } from 'node:crypto';
import type { ConversationSummary, Message } from '../../shared/protocol.ts';

export interface AppendInput {
  clientId: string;
  from: string;
  fromName: string;
  body: string;
}

/** Everything the server needs from persistence. Swap MemoryStore for a DB-backed one. */
export interface Store {
  ensureConversation(id: string, customerId: string, customerName: string): { conversation: ConversationSummary; created: boolean };
  getConversation(id: string): ConversationSummary | undefined;
  listConversations(): ConversationSummary[];
  /** Idempotent per (conv, clientId): a retry returns the original message with duplicate=true. */
  append(conv: string, input: AppendInput): { msg: Message; duplicate: boolean };
  since(conv: string, seq: number): Message[];
  markRead(conv: string, userId: string, seq: number): number;
}

interface Conv {
  summary: ConversationSummary;
  messages: Message[];
  byClientId: Map<string, Message>;
}

// ponytail: unbounded in-memory arrays, fine for a demo; a DB store pages `since` and caps history.
export class MemoryStore implements Store {
  private convs = new Map<string, Conv>();

  ensureConversation(id: string, customerId: string, customerName: string) {
    const existing = this.convs.get(id);
    if (existing) return { conversation: existing.summary, created: false };
    const summary: ConversationSummary = { id, customerId, customerName, lastSeq: 0, reads: {} };
    this.convs.set(id, { summary, messages: [], byClientId: new Map() });
    return { conversation: summary, created: true };
  }

  getConversation(id: string) {
    return this.convs.get(id)?.summary;
  }

  listConversations() {
    return [...this.convs.values()].map((c) => c.summary).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  }

  append(conv: string, input: AppendInput) {
    const c = this.convs.get(conv);
    if (!c) throw new Error(`unknown conversation ${conv}`);
    const prior = c.byClientId.get(input.clientId);
    if (prior) return { msg: prior, duplicate: true };
    const msg: Message = { id: randomUUID(), conv, seq: c.summary.lastSeq + 1, at: Date.now(), ...input };
    c.messages.push(msg);
    c.byClientId.set(input.clientId, msg);
    c.summary.lastSeq = msg.seq;
    c.summary.last = msg;
    c.summary.reads[input.from] = msg.seq; // you have read what you wrote
    return { msg, duplicate: false };
  }

  since(conv: string, seq: number) {
    const msgs = this.convs.get(conv)?.messages ?? [];
    // seq starts at 1 and has no gaps, so the index is seq - 1.
    return msgs.slice(Math.max(0, seq));
  }

  markRead(conv: string, userId: string, seq: number) {
    const c = this.convs.get(conv);
    if (!c) return 0;
    const next = Math.min(Math.max(c.summary.reads[userId] ?? 0, seq), c.summary.lastSeq);
    c.summary.reads[userId] = next;
    return next;
  }
}
