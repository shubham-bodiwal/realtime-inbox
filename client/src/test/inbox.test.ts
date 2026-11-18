import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientFrame, Message, ServerFrame } from '../../../shared/protocol.ts';
import { initialState, merge, reducer, unreadCount, useInbox, ACK_TIMEOUT, type InboxState } from '../inbox.ts';

const msg = (seq: number, over: Partial<Message> = {}): Message => ({
  id: `m${seq}`, clientId: `c${seq}`, conv: 'conv_a', seq, from: 'a', fromName: 'A', body: `#${seq}`, at: seq, ...over,
});
const summary = { id: 'conv_a', customerId: 'a', customerName: 'A', lastSeq: 0, reads: {} };
const srv = (s: InboxState, frame: ServerFrame) => reducer(s, { type: 'server', frame, now: 0 });

describe('reducer', () => {
  it('merges out-of-order and duplicate messages into one sorted list', () => {
    expect(merge([msg(1), msg(3)], [msg(2), msg(3), msg(1)]).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('replaces the optimistic copy when the ack (or a resumed history) arrives', () => {
    let s = srv(initialState, { t: 'welcome', conversations: [summary], online: [] });
    s = reducer(s, { type: 'queue', pending: { clientId: 'c1', conv: 'conv_a', body: 'hi', at: 0, state: 'sending' } });
    expect(s.pending).toHaveLength(1);
    s = srv(s, { t: 'history', conv: 'conv_a', messages: [msg(1)] }); // landed before the drop
    expect(s.pending).toHaveLength(0);
    s = srv(s, { t: 'ack', clientId: 'c1', msg: msg(1) }); // late ack is harmless
    expect(s.convs.conv_a.messages).toHaveLength(1);
  });

  it('counts unread messages from others after my read marker (sending implies read)', () => {
    let s = srv(initialState, { t: 'welcome', conversations: [summary], online: [] });
    s = srv(s, { t: 'history', conv: 'conv_a', messages: [msg(1, { from: 'me' }), msg(2), msg(3)] });
    expect(unreadCount(s.convs.conv_a, 'me')).toBe(2);
    s = srv(s, { t: 'read', conv: 'conv_a', userId: 'me', seq: 3 });
    expect(unreadCount(s.convs.conv_a, 'me')).toBe(0);
  });

  it('marks a pending message failed when the server rejects it', () => {
    let s = reducer(initialState, { type: 'queue', pending: { clientId: 'c9', conv: 'conv_a', body: 'x', at: 0, state: 'sending' } });
    s = srv(s, { t: 'error', code: 'rate_limited', message: 'Slow down', clientId: 'c9' });
    expect(s.pending[0]).toMatchObject({ state: 'failed', error: 'Slow down' });
  });
});

/** Minimal in-process WebSocket double: records sent frames, lets the test push server frames. */
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: ClientFrame[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  push(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

describe('useInbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const me = { userId: 'me', name: 'Me', role: 'customer' as const };
  const welcome = (s: FakeSocket) => act(() => s.push({ t: 'welcome', conversations: [summary], online: [] }));

  it('sends optimistically, queues while offline, and resumes from the last seq after reconnect', () => {
    const { result } = renderHook(() => useInbox({ url: 'ws://x/ws', me }));
    const s1 = FakeSocket.all[0];
    act(() => s1.open());
    expect(s1.sent[0]).toMatchObject({ t: 'hello', userId: 'me' });
    welcome(s1);
    act(() => s1.push({ t: 'history', conv: 'conv_a', messages: [msg(1), msg(2)] }));

    act(() => s1.close()); // drop
    expect(result.current.state.status).toBe('reconnecting');
    act(() => result.current.send('conv_a', 'while offline'));
    expect(result.current.state.pending[0]).toMatchObject({ body: 'while offline', state: 'sending' });

    act(() => vi.advanceTimersByTime(1000)); // backoff elapses
    const s2 = FakeSocket.all[1];
    act(() => s2.open());
    welcome(s2);
    expect(s2.sent.find((f) => f.t === 'join')).toEqual({ t: 'join', conv: 'conv_a', since: 2 });
    const resent = s2.sent.find((f) => f.t === 'send') as Extract<ClientFrame, { t: 'send' }>;
    expect(resent.body).toBe('while offline');

    act(() => s2.push({ t: 'ack', clientId: resent.clientId, msg: msg(3, { from: 'me', clientId: resent.clientId }) }));
    expect(result.current.state.pending).toHaveLength(0);
    expect(result.current.state.convs.conv_a.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('fails a send with no ack, and retry reuses the same clientId', () => {
    const { result } = renderHook(() => useInbox({ url: 'ws://x/ws', me }));
    const s = FakeSocket.all[0];
    act(() => s.open());
    welcome(s);
    act(() => result.current.send('conv_a', 'hello'));
    act(() => vi.advanceTimersByTime(ACK_TIMEOUT));
    expect(result.current.state.pending[0].state).toBe('failed');

    act(() => result.current.retry(result.current.state.pending[0].clientId));
    const sends = s.sent.filter((f) => f.t === 'send') as Extract<ClientFrame, { t: 'send' }>[];
    expect(sends).toHaveLength(2);
    expect(sends[0].clientId).toBe(sends[1].clientId);
    expect(result.current.state.pending[0].state).toBe('sending');
  });

  it('expires a typing indicator that never got an "off"', () => {
    const { result } = renderHook(() => useInbox({ url: 'ws://x/ws', me }));
    const s = FakeSocket.all[0];
    act(() => s.open());
    welcome(s);
    act(() => s.push({ t: 'typing', conv: 'conv_a', userId: 'agent', name: 'Mira', on: true }));
    expect(Object.keys(result.current.state.convs.conv_a.typing)).toEqual(['agent']);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.state.convs.conv_a.typing).toEqual({});
  });
});
