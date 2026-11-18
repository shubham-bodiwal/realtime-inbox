import { ArrowLeft, Bell, BellRinging, Tray } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { Message } from '../../shared/protocol.ts';
import { AGENT, WS_URL, initials, time } from './identity.ts';
import { unreadCount, useInbox } from './inbox.ts';
import { ConnectionBar, OfflineToggle } from './Status.tsx';
import { Thread } from './Thread.tsx';

const canNotify = typeof Notification !== 'undefined';

function notify(msg: Message) {
  if (canNotify && Notification.permission === 'granted' && document.hidden)
    new Notification(msg.fromName, { body: msg.body, tag: msg.conv });
}

export function AgentView() {
  const { state, send, retry, typing, markRead, setOnline } = useInbox({ url: WS_URL, me: AGENT, onIncoming: notify });
  const [selected, setSelected] = useState<string | null>(null);
  const [perm, setPerm] = useState(canNotify ? Notification.permission : 'denied');
  const convs = Object.values(state.convs).sort((a, b) => (b.summary.last?.at ?? 0) - (a.summary.last?.at ?? 0));
  const active = selected ? state.convs[selected] : undefined;
  const totalUnread = convs.reduce((n, c) => n + unreadCount(c, AGENT.userId), 0);

  // Reading an open conversation while the tab is visible clears its unread count.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-mark when the open conversation or its message count changes
  useEffect(() => {
    if (!active) return;
    const mark = () => !document.hidden && markRead(active.summary.id);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [active?.summary.id, active?.messages.length, markRead]);

  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Realtime Inbox` : 'Realtime Inbox';
  }, [totalUnread]);

  return (
    <section className={`agent ${active ? 'has-active' : ''}`} aria-label="Agent inbox">
      <aside className="sidebar">
        <header className="pane-head">
          <h2>Inbox {totalUnread > 0 && <span className="count">{totalUnread}</span>}</h2>
          <div className="actions">
            {perm === 'default' && (
              <button type="button" className="ghost icon" aria-label="Enable desktop notifications" title="Enable desktop notifications"
                onClick={() => Notification.requestPermission().then(setPerm)}>
                <Bell size={16} />
              </button>
            )}
            {perm === 'granted' && <BellRinging size={16} className="muted" aria-label="Notifications on" />}
            <OfflineToggle state={state} setOnline={setOnline} />
          </div>
        </header>
        <ConnectionBar state={state} />
        <ul className="conv-list">
          {state.status === 'connecting' && convs.length === 0 &&
            [0, 1, 2].map((i) => <li key={i} className="skeleton" aria-hidden />)}
          {state.status !== 'connecting' && convs.length === 0 && (
            <li className="empty">
              <Tray size={28} />
              No conversations yet. Open the <a href="#/widget">customer widget</a> in another tab and say hello.
            </li>
          )}
          {convs.map((c) => {
            const unread = unreadCount(c, AGENT.userId);
            const last = c.summary.last;
            const online = state.online.includes(c.summary.customerId);
            const isTyping = Object.keys(c.typing).length > 0;
            return (
              <li key={c.summary.id}>
                <button type="button" className={`conv ${c.summary.id === selected ? 'active' : ''} ${unread ? 'unread' : ''}`}
                  aria-current={c.summary.id === selected} onClick={() => setSelected(c.summary.id)}>
                  <span className="avatar">
                    {initials(c.summary.customerName)}
                    {online && <i className="presence" role="img" aria-label="online" />}
                  </span>
                  <span className="conv-main">
                    <span className="conv-top">
                      <strong>{c.summary.customerName}</strong>
                      {last && <time>{time(last.at)}</time>}
                    </span>
                    <span className="conv-bottom">
                      <span className="preview">
                        {isTyping ? <em>typing</em> : last ? `${last.from === AGENT.userId ? 'You: ' : ''}${last.body}` : 'No messages yet'}
                      </span>
                      {unread > 0 && <span className="badge">{unread}<span className="sr-only"> unread</span></span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="detail">
        {active ? (
          <>
            <header className="pane-head">
              <button type="button" className="ghost icon back" aria-label="Back to inbox" onClick={() => setSelected(null)}>
                <ArrowLeft size={18} />
              </button>
              <div className="title">
                <h2>{active.summary.customerName}</h2>
                <span className="sub">{state.online.includes(active.summary.customerId) ? 'Online now' : 'Away'}</span>
              </div>
            </header>
            <Thread
              me={AGENT.userId}
              conv={active}
              pending={state.pending.filter((p) => p.conv === active.summary.id)}
              empty="No messages in this conversation yet."
              onSend={(b) => send(active.summary.id, b)}
              onRetry={retry}
              onTyping={(on) => typing(active.summary.id, on)}
            />
          </>
        ) : (
          <div className="placeholder">
            <Tray size={32} />
            <p>Pick a conversation to reply.</p>
          </div>
        )}
      </div>
    </section>
  );
}
