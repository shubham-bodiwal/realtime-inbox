import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_BODY,
  customerConv,
  type ClientFrame,
  type Role,
  type ServerFrame,
} from '../../shared/protocol.ts';
import { MemoryStore, type Store } from './store.ts';

interface Conn {
  ws: WebSocket;
  userId?: string;
  name?: string;
  role?: Role;
  rooms: Set<string>;
  tokens: number;
  refilledAt: number;
}

export interface InboxOptions {
  store?: Store;
  /** Token bucket for `send` frames: `burst` messages, refilled at `perSecond`. */
  rate?: { burst: number; perSecond: number };
}

export function attachInbox(http: HttpServer, opts: InboxOptions = {}) {
  const store = opts.store ?? new MemoryStore();
  const rate = opts.rate ?? { burst: 8, perSecond: 2 };
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });
  const rooms = new Map<string, Set<Conn>>();
  const agents = new Set<Conn>();
  const online = new Map<string, number>(); // userId -> open connections

  const send = (c: Conn, f: ServerFrame) => c.ws.readyState === c.ws.OPEN && c.ws.send(JSON.stringify(f));
  const room = (id: string) => rooms.get(id) ?? rooms.set(id, new Set()).get(id)!;
  const toRoom = (id: string, f: ServerFrame, except?: Conn) => {
    for (const c of room(id)) if (c !== except) send(c, f);
  };
  const join = (c: Conn, id: string) => {
    room(id).add(c);
    c.rooms.add(id);
  };
  /** Everyone sharing at least one room with `c`, each once. */
  const peers = (c: Conn) => {
    const out = new Set<Conn>();
    for (const id of c.rooms) for (const p of room(id)) if (p !== c) out.add(p);
    return out;
  };
  const setPresence = (c: Conn, delta: 1 | -1) => {
    const id = c.userId!;
    const n = (online.get(id) ?? 0) + delta;
    n > 0 ? online.set(id, n) : online.delete(id);
    const changed = (delta === 1 && n === 1) || (delta === -1 && n === 0);
    if (changed) for (const p of peers(c)) send(p, { t: 'presence', userId: id, online: n > 0 });
  };
  const takeToken = (c: Conn) => {
    const now = Date.now();
    c.tokens = Math.min(rate.burst, c.tokens + ((now - c.refilledAt) / 1000) * rate.perSecond);
    c.refilledAt = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  };
  const canAccess = (c: Conn, conv: string) => c.role === 'agent' || conv === customerConv(c.userId!);

  wss.on('connection', (ws) => {
    const c: Conn = { ws, rooms: new Set(), tokens: rate.burst, refilledAt: Date.now() };

    ws.on('message', (raw) => {
      let f: ClientFrame;
      try {
        f = JSON.parse(String(raw));
        if (typeof f?.t !== 'string') throw new Error();
      } catch {
        return send(c, { t: 'error', code: 'bad_frame', message: 'Frames must be JSON objects with a "t" field.' });
      }

      if (f.t === 'hello') {
        if (c.userId) return; // one identity per socket
        const ok = typeof f.userId === 'string' && /^[\w-]{1,64}$/.test(f.userId) && typeof f.name === 'string';
        if (!ok || (f.role !== 'agent' && f.role !== 'customer'))
          return send(c, { t: 'error', code: 'bad_frame', message: 'hello needs userId, name and role.' });
        // ponytail: identity is self-declared. A real deployment verifies a session token here.
        Object.assign(c, { userId: f.userId, name: f.name.slice(0, 60), role: f.role });
        if (c.role === 'agent') {
          agents.add(c);
          for (const conv of store.listConversations()) join(c, conv.id);
        } else {
          const id = customerConv(c.userId!);
          const { conversation, created } = store.ensureConversation(id, c.userId!, c.name!);
          if (created) for (const a of agents) (join(a, id), send(a, { t: 'conversation', conversation }));
          join(c, id);
        }
        const visible = c.role === 'agent' ? [...online.keys()] : [...agents].map((a) => a.userId!);
        send(c, {
          t: 'welcome',
          conversations: c.role === 'agent' ? store.listConversations() : [store.getConversation(customerConv(c.userId!))!],
          online: [...new Set(visible)],
        });
        return setPresence(c, 1);
      }

      if (!c.userId) return send(c, { t: 'error', code: 'not_hello', message: 'Send hello first.' });
      if (typeof f.conv !== 'string' || !store.getConversation(f.conv) || !canAccess(c, f.conv))
        return send(c, { t: 'error', code: 'forbidden', message: 'No access to that conversation.' });

      switch (f.t) {
        case 'join': {
          join(c, f.conv);
          const since = Number.isInteger(f.since) && f.since > 0 ? f.since : 0;
          return send(c, { t: 'history', conv: f.conv, messages: store.since(f.conv, since) });
        }
        case 'send': {
          const body = typeof f.body === 'string' ? f.body.trim() : '';
          if (typeof f.clientId !== 'string' || !f.clientId || f.clientId.length > 64 || !body)
            return send(c, { t: 'error', code: 'bad_frame', message: 'send needs clientId and body.' });
          if (body.length > MAX_BODY)
            return send(c, { t: 'error', code: 'too_long', message: `Max ${MAX_BODY} characters.`, clientId: f.clientId });
          if (!takeToken(c))
            return send(c, { t: 'error', code: 'rate_limited', message: 'Slow down a little.', clientId: f.clientId });
          const { msg, duplicate } = store.append(f.conv, { clientId: f.clientId, from: c.userId, fromName: c.name!, body });
          send(c, { t: 'ack', clientId: f.clientId, msg });
          if (!duplicate) toRoom(f.conv, { t: 'message', msg }, c);
          return;
        }
        case 'typing':
          return toRoom(f.conv, { t: 'typing', conv: f.conv, userId: c.userId, name: c.name!, on: !!f.on }, c);
        case 'read': {
          if (!Number.isInteger(f.seq)) return;
          const seq = store.markRead(f.conv, c.userId, f.seq);
          return toRoom(f.conv, { t: 'read', conv: f.conv, userId: c.userId, seq });
        }
        default:
          return send(c, { t: 'error', code: 'bad_frame', message: 'Unknown frame type.' });
      }
    });

    ws.on('close', () => {
      if (c.userId) setPresence(c, -1);
      for (const id of c.rooms) rooms.get(id)?.delete(c);
      agents.delete(c);
    });
  });

  return { wss, store };
}
