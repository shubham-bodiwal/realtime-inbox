import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ClientFrame, ConversationSummary, Message, Role, ServerFrame } from '../../shared/protocol.ts';

export interface Identity {
  userId: string;
  name: string;
  role: Role;
}

export interface Pending {
  clientId: string;
  conv: string;
  body: string;
  at: number;
  state: 'sending' | 'failed';
  error?: string;
}

export interface ConvState {
  summary: ConversationSummary;
  messages: Message[]; // confirmed, sorted by seq, unique by id
  typing: Record<string, { name: string; at: number }>;
}

export interface InboxState {
  status: 'connecting' | 'open' | 'reconnecting' | 'offline';
  convs: Record<string, ConvState>;
  pending: Pending[];
  online: string[];
}

export type Action =
  | { type: 'status'; status: InboxState['status'] }
  | { type: 'server'; frame: ServerFrame; now: number }
  | { type: 'queue'; pending: Pending }
  | { type: 'fail'; clientId: string; error: string }
  | { type: 'retry'; clientId: string }
  | { type: 'typingExpire'; conv: string; userId: string; at: number };

export const initialState: InboxState = { status: 'connecting', convs: {}, pending: [], online: [] };

export const lastSeq = (c?: ConvState) => c?.messages.at(-1)?.seq ?? 0;

/** Insert messages, keeping the list sorted by seq and free of duplicates. */
export function merge(list: Message[], incoming: Message[]): Message[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function upsertConv(s: InboxState, summary: ConversationSummary): InboxState {
  const prev = s.convs[summary.id];
  const next: ConvState = prev ? { ...prev, summary: { ...prev.summary, ...summary } } : { summary, messages: [], typing: {} };
  return { ...s, convs: { ...s.convs, [summary.id]: next } };
}

function addMessages(s: InboxState, conv: string, msgs: Message[]): InboxState {
  const c = s.convs[conv];
  if (!c || !msgs.length) return s;
  const messages = merge(c.messages, msgs);
  const last = messages.at(-1)!;
  const typing = { ...c.typing };
  for (const m of msgs) delete typing[m.from];
  const reads = { ...c.summary.reads };
  for (const m of msgs) reads[m.from] = Math.max(reads[m.from] ?? 0, m.seq);
  const sent = new Set(msgs.map((m) => m.clientId));
  return {
    ...s,
    pending: s.pending.filter((p) => !(p.conv === conv && sent.has(p.clientId))),
    convs: { ...s.convs, [conv]: { ...c, messages, typing, summary: { ...c.summary, last, lastSeq: Math.max(c.summary.lastSeq, last.seq), reads } } },
  };
}

export function reducer(s: InboxState, a: Action): InboxState {
  switch (a.type) {
    case 'status':
      return { ...s, status: a.status };
    case 'queue':
      return { ...s, pending: [...s.pending, a.pending] };
    case 'fail':
      return { ...s, pending: s.pending.map((p) => (p.clientId === a.clientId ? { ...p, state: 'failed', error: a.error } : p)) };
    case 'retry':
      return { ...s, pending: s.pending.map((p) => (p.clientId === a.clientId ? { ...p, state: 'sending', error: undefined } : p)) };
    case 'typingExpire': {
      const c = s.convs[a.conv];
      if (c?.typing[a.userId]?.at !== a.at) return s;
      const { [a.userId]: _, ...typing } = c.typing;
      return { ...s, convs: { ...s.convs, [a.conv]: { ...c, typing } } };
    }
    case 'server': {
      const f = a.frame;
      switch (f.t) {
        case 'welcome':
          return { ...f.conversations.reduce(upsertConv, s), status: 'open', online: f.online };
        case 'conversation':
          return upsertConv(s, f.conversation);
        case 'history':
          return addMessages(s, f.conv, f.messages);
        case 'message':
          return addMessages(s, f.msg.conv, [f.msg]);
        case 'ack':
          return addMessages(s, f.msg.conv, [f.msg]);
        case 'error':
          return f.clientId ? reducer(s, { type: 'fail', clientId: f.clientId, error: f.message }) : s;
        case 'presence':
          return { ...s, online: f.online ? [...new Set([...s.online, f.userId])] : s.online.filter((u) => u !== f.userId) };
        case 'read': {
          const c = s.convs[f.conv];
          if (!c) return s;
          const reads = { ...c.summary.reads, [f.userId]: Math.max(c.summary.reads[f.userId] ?? 0, f.seq) };
          return { ...s, convs: { ...s.convs, [f.conv]: { ...c, summary: { ...c.summary, reads } } } };
        }
        case 'typing': {
          const c = s.convs[f.conv];
          if (!c) return s;
          const typing = { ...c.typing };
          if (f.on) typing[f.userId] = { name: f.name, at: a.now };
          else delete typing[f.userId];
          return { ...s, convs: { ...s.convs, [f.conv]: { ...c, typing } } };
        }
      }
    }
  }
  return s;
}

export const unreadCount = (c: ConvState, me: string) =>
  c.messages.filter((m) => m.from !== me && m.seq > (c.summary.reads[me] ?? 0)).length;

export const ACK_TIMEOUT = 8000;
export const TYPING_TTL = 4000;

export interface InboxOptions {
  url: string;
  me: Identity;
  onIncoming?: (msg: Message) => void;
}

export function useInbox({ url, me, onIncoming }: InboxOptions) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ws = useRef<WebSocket | null>(null);
  const wantOnline = useRef(true);
  const attempt = useRef(0);
  const ackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const incoming = useRef(onIncoming);
  incoming.current = onIncoming;

  const raw = useCallback((f: ClientFrame) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return false;
    ws.current.send(JSON.stringify(f));
    return true;
  }, []);

  const transmit = useCallback(
    (p: Pending) => {
      clearTimeout(ackTimers.current.get(p.clientId));
      // Offline: stay queued as "sending"; the welcome handler flushes the outbox.
      if (!raw({ t: 'send', conv: p.conv, clientId: p.clientId, body: p.body })) return;
      ackTimers.current.set(
        p.clientId,
        setTimeout(() => dispatch({ type: 'fail', clientId: p.clientId, error: 'Not delivered' }), ACK_TIMEOUT),
      );
    },
    [raw],
  );

  const connectRef = useRef<() => void>(() => {});
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect only when the server URL or identity changes
  useEffect(() => {
    let closed = false;

    const connect = () => {
      const sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', ...me } satisfies ClientFrame));
      sock.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as ServerFrame;
        dispatch({ type: 'server', frame, now: Date.now() });
        if (frame.t === 'welcome') {
          attempt.current = 0;
          // Resume: ask each room only for what we have not seen, then flush the outbox.
          // The server dedupes by clientId, so resending something that already landed is safe.
          for (const c of frame.conversations) raw({ t: 'join', conv: c.id, since: lastSeq(stateRef.current.convs[c.id]) });
          for (const p of stateRef.current.pending) if (p.state === 'sending') transmit(p);
        } else if (frame.t === 'conversation') {
          raw({ t: 'join', conv: frame.conversation.id, since: 0 });
        } else if (frame.t === 'ack' || (frame.t === 'error' && frame.clientId)) {
          const id = frame.t === 'ack' ? frame.clientId : frame.clientId!;
          clearTimeout(ackTimers.current.get(id));
          ackTimers.current.delete(id);
        } else if (frame.t === 'message' && frame.msg.from !== me.userId) {
          incoming.current?.(frame.msg);
        } else if (frame.t === 'typing' && frame.on) {
          const at = Date.now();
          setTimeout(() => dispatch({ type: 'typingExpire', conv: frame.conv, userId: frame.userId, at }), TYPING_TTL);
        }
      };
      sock.onclose = () => {
        if (closed || ws.current !== sock) return;
        // In-flight sends go back to the queue instead of timing out into "failed".
        ackTimers.current.forEach(clearTimeout);
        ackTimers.current.clear();
        if (!wantOnline.current) return dispatch({ type: 'status', status: 'offline' });
        dispatch({ type: 'status', status: 'reconnecting' });
        // ponytail: plain exponential backoff with jitter, capped at 8s.
        const delay = Math.min(8000, 500 * 2 ** attempt.current++) * (0.75 + Math.random() / 2);
        retryTimer.current = setTimeout(connect, delay);
      };
    };

    connectRef.current = connect;
    connect();
    const timers = ackTimers.current;
    return () => {
      closed = true;
      clearTimeout(retryTimer.current);
      ws.current?.close();
      timers.forEach(clearTimeout);
    };
  }, [url, me.userId, me.role]);

  const send = useCallback(
    (conv: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      const p: Pending = { clientId: crypto.randomUUID(), conv, body: text, at: Date.now(), state: 'sending' };
      dispatch({ type: 'queue', pending: p }); // optimistic: shows immediately
      transmit(p);
    },
    [transmit],
  );

  const retry = useCallback(
    (clientId: string) => {
      const p = stateRef.current.pending.find((x) => x.clientId === clientId);
      if (!p) return;
      dispatch({ type: 'retry', clientId });
      transmit(p);
    },
    [transmit],
  );

  const lastTyping = useRef(0);
  const typing = useCallback(
    (conv: string, on: boolean) => {
      const now = Date.now();
      if (on && now - lastTyping.current < 2000) return; // throttle "on" pings
      lastTyping.current = on ? now : 0;
      raw({ t: 'typing', conv, on });
    },
    [raw],
  );

  const markRead = useCallback(
    (conv: string) => {
      const c = stateRef.current.convs[conv];
      const seq = lastSeq(c);
      if (c && seq > (c.summary.reads[me.userId] ?? 0)) {
        dispatch({ type: 'server', frame: { t: 'read', conv, userId: me.userId, seq }, now: Date.now() });
        raw({ t: 'read', conv, seq });
      }
    },
    [raw, me.userId],
  );

  /** Demo control: drop the socket and stay offline, or come back and resume. */
  const setOnline = useCallback((on: boolean) => {
    wantOnline.current = on;
    clearTimeout(retryTimer.current);
    if (!on) return ws.current?.close();
    if (ws.current?.readyState === WebSocket.CLOSED) {
      dispatch({ type: 'status', status: 'connecting' });
      connectRef.current();
    }
  }, []);

  return { state, send, retry, typing, markRead, setOnline };
}
