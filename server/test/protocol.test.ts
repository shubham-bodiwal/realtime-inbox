import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientFrame, Role, ServerFrame } from '../../shared/protocol.ts';
import { attachInbox, type InboxOptions } from '../src/server.ts';

let http: Server;
const sockets: WebSocket[] = [];

async function start(opts?: InboxOptions) {
  http = createServer();
  const inbox = attachInbox(http, opts);
  await new Promise<void>((r) => http.listen(0, r));
  return inbox;
}

/** A test client that records every frame and can wait for one matching a predicate. */
async function client(userId: string, role: Role) {
  const ws = new WebSocket(`ws://localhost:${(http.address() as AddressInfo).port}/ws`);
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  const waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as ServerFrame;
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(f));
  });
  await new Promise((r) => ws.once('open', r));
  const out = {
    ws,
    frames,
    send: (f: ClientFrame) => ws.send(JSON.stringify(f)),
    next: <T extends ServerFrame['t']>(t: T, pred: (f: Extract<ServerFrame, { t: T }>) => boolean = () => true) => {
      const hit = frames.find((f) => f.t === t && pred(f as never));
      if (hit) frames.splice(frames.indexOf(hit), 1);
      return hit
        ? Promise.resolve(hit as Extract<ServerFrame, { t: T }>)
        : new Promise<Extract<ServerFrame, { t: T }>>((resolve) =>
            waiters.push({ pred: (f) => f.t === t && pred(f as never), resolve: (f) => (frames.splice(frames.indexOf(f), 1), resolve(f as never)) }),
          );
    },
  };
  out.send({ t: 'hello', userId, name: userId, role });
  await out.next('welcome');
  return out;
}

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate());
  await new Promise((r) => http.close(r));
});

describe('protocol', () => {
  it('assigns strictly increasing seq per conversation and every member sees the same order', async () => {
    await start({ rate: { burst: 100, perSecond: 100 } });
    const cust = await client('ana', 'customer');
    const agent = await client('agent-1', 'agent');
    const conv = 'conv_ana';
    for (let i = 0; i < 20; i++) {
      cust.send({ t: 'send', conv, clientId: `c${i}`, body: `c${i}` });
      agent.send({ t: 'send', conv, clientId: `a${i}`, body: `a${i}` });
    }
    const acks = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => cust.next('ack', (f) => f.clientId === `c${i}`)),
      ...Array.from({ length: 20 }, (_, i) => agent.next('ack', (f) => f.clientId === `a${i}`)),
    ]);
    expect(acks.map((a) => a.msg.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    // Each side's own acks + others' broadcasts reconstruct the same ordered log.
    const viewOf = async (c: typeof cust, mine: string) => {
      const theirs = await Promise.all(
        Array.from({ length: 20 }, (_, i) => c.next('message', (f) => f.msg.clientId === `${mine === 'c' ? 'a' : 'c'}${i}`)),
      );
      const own = acks.filter((a) => a.clientId.startsWith(mine)).map((a) => a.msg);
      return [...own, ...theirs.map((t) => t.msg)].sort((x, y) => x.seq - y.seq).map((m) => m.id);
    };
    expect(await viewOf(cust, 'c')).toEqual(await viewOf(agent, 'a'));
  });

  it('dedupes a retried send by clientId', async () => {
    await start();
    const cust = await client('ben', 'customer');
    const agent = await client('agent-1', 'agent');
    cust.send({ t: 'send', conv: 'conv_ben', clientId: 'same', body: 'hello' });
    cust.send({ t: 'send', conv: 'conv_ben', clientId: 'same', body: 'hello' });
    const [a1, a2] = [await cust.next('ack'), await cust.next('ack')];
    expect(a1.msg.id).toBe(a2.msg.id);
    expect(a1.msg.seq).toBe(1);

    agent.send({ t: 'join', conv: 'conv_ben', since: 0 });
    const history = await agent.next('history');
    expect(history.messages).toHaveLength(1);
    expect(agent.frames.filter((f) => f.t === 'message')).toHaveLength(1); // broadcast once, not twice
  });

  it('resumes from the last seen seq with no gaps and no repeats', async () => {
    await start();
    let cust = await client('cyd', 'customer');
    const agent = await client('agent-1', 'agent');
    const conv = 'conv_cyd';
    cust.send({ t: 'send', conv, clientId: 'k1', body: 'one' });
    const seen = (await cust.next('ack')).msg.seq;

    cust.ws.terminate(); // connection drops
    await agent.next('presence', (f) => f.userId === 'cyd' && !f.online);
    for (const n of ['two', 'three']) agent.send({ t: 'send', conv, clientId: n, body: n });
    await agent.next('ack');
    await agent.next('ack');

    cust = await client('cyd', 'customer');
    cust.send({ t: 'join', conv, since: seen });
    const { messages } = await cust.next('history');
    expect(messages.map((m) => [m.seq, m.body])).toEqual([[2, 'two'], [3, 'three']]);
  });

  it('broadcasts typing and read receipts to the room, not to the sender', async () => {
    await start();
    const cust = await client('dee', 'customer');
    const agent = await client('agent-1', 'agent');
    cust.send({ t: 'send', conv: 'conv_dee', clientId: 'x', body: 'hi' });
    await cust.next('ack');
    agent.send({ t: 'typing', conv: 'conv_dee', on: true });
    expect(await cust.next('typing')).toMatchObject({ userId: 'agent-1', on: true });
    agent.send({ t: 'read', conv: 'conv_dee', seq: 99 });
    expect(await cust.next('read')).toMatchObject({ userId: 'agent-1', seq: 1 }); // clamped to lastSeq
    expect(agent.frames.some((f) => f.t === 'typing')).toBe(false);
  });

  it('keeps customers out of other conversations', async () => {
    await start();
    await client('eve', 'customer');
    const mal = await client('mal', 'customer');
    mal.send({ t: 'join', conv: 'conv_eve', since: 0 });
    expect(await mal.next('error')).toMatchObject({ code: 'forbidden' });
  });

  it('rate limits sends per connection and reports which message was dropped', async () => {
    await start({ rate: { burst: 3, perSecond: 0.001 } });
    const cust = await client('fay', 'customer');
    for (let i = 0; i < 4; i++) cust.send({ t: 'send', conv: 'conv_fay', clientId: `m${i}`, body: 'spam' });
    expect(await cust.next('error')).toMatchObject({ code: 'rate_limited', clientId: 'm3' });
  });

  it('tells agents about new conversations and presence', async () => {
    await start();
    const agent = await client('agent-1', 'agent');
    await client('gus', 'customer');
    expect((await agent.next('conversation')).conversation.id).toBe('conv_gus');
    expect(await agent.next('presence')).toMatchObject({ userId: 'gus', online: true });
  });
});
