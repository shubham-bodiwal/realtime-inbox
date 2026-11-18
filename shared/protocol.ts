// Wire protocol shared by server and client. JSON text frames, one message per frame.

export type Role = 'agent' | 'customer';

export interface Message {
  id: string; // server id, globally unique
  clientId: string; // sender-chosen id, used for dedupe on retry
  conv: string;
  seq: number; // per-conversation, strictly increasing from 1
  from: string; // userId
  fromName: string;
  body: string;
  at: number; // server time, ms
}

export interface ConversationSummary {
  id: string;
  customerId: string;
  customerName: string;
  lastSeq: number;
  last?: Message;
  reads: Record<string, number>; // userId -> highest seq read
}

export type ClientFrame =
  | { t: 'hello'; userId: string; name: string; role: Role }
  | { t: 'join'; conv: string; since: number }
  | { t: 'send'; conv: string; clientId: string; body: string }
  | { t: 'typing'; conv: string; on: boolean }
  | { t: 'read'; conv: string; seq: number };

export type ServerFrame =
  | { t: 'welcome'; conversations: ConversationSummary[]; online: string[] }
  | { t: 'history'; conv: string; messages: Message[] }
  | { t: 'message'; msg: Message }
  | { t: 'ack'; clientId: string; msg: Message }
  | { t: 'typing'; conv: string; userId: string; name: string; on: boolean }
  | { t: 'read'; conv: string; userId: string; seq: number }
  | { t: 'presence'; userId: string; online: boolean }
  | { t: 'conversation'; conversation: ConversationSummary }
  | { t: 'error'; code: ErrorCode; message: string; clientId?: string };

export type ErrorCode = 'bad_frame' | 'not_hello' | 'forbidden' | 'rate_limited' | 'too_long';

export const MAX_BODY = 2000;
export const customerConv = (userId: string) => `conv_${userId}`;
