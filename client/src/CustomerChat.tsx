import { X } from '@phosphor-icons/react';
import { useEffect, useMemo } from 'react';
import { customerConv } from '../../shared/protocol.ts';
import { customerIdentity, WS_URL } from './identity.ts';
import { useInbox } from './inbox.ts';
import { ConnectionBar, OfflineToggle } from './Status.tsx';
import { Thread } from './Thread.tsx';

export function CustomerChat({ onClose }: { onClose?: () => void }) {
  const me = useMemo(customerIdentity, []);
  const { state, send, retry, typing, markRead, setOnline } = useInbox({ url: WS_URL, me });
  const convId = customerConv(me.userId);
  const conv = state.convs[convId];
  const agentOnline = state.online.some((u) => u.startsWith('agent-'));

  useEffect(() => {
    const mark = () => !document.hidden && markRead(convId);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [convId, conv?.messages.length, markRead]);

  return (
    <section className="widget" aria-label="Support chat">
      <header className="pane-head">
        <div className="title">
          <h2>Support</h2>
          <span className="sub">{agentOnline ? 'Mira is online, usually replies in minutes' : 'Leave a message, we reply right here'}</span>
        </div>
        <div className="actions">
          <OfflineToggle state={state} setOnline={setOnline} />
          {onClose && <button type="button" className="ghost icon" aria-label="Close chat" onClick={onClose}><X size={16} /></button>}
        </div>
      </header>
      <ConnectionBar state={state} />
      {conv ? (
        <Thread
          me={me.userId}
          conv={conv}
          pending={state.pending.filter((p) => p.conv === convId)}
          empty={`Hi ${me.name.split(' ')[0]}. Ask us anything, we read every message.`}
          onSend={(b) => send(convId, b)}
          onRetry={retry}
          onTyping={(on) => typing(convId, on)}
        />
      ) : (
        <div className="thread"><div className="messages"><div className="skeleton" /><div className="skeleton short" /></div></div>
      )}
    </section>
  );
}
