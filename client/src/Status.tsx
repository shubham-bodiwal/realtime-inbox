import { WifiHigh, WifiSlash } from '@phosphor-icons/react';
import type { InboxState } from './inbox.ts';

export function ConnectionBar({ state }: { state: InboxState }) {
  if (state.status === 'open') return null;
  const queued = state.pending.filter((p) => p.state === 'sending').length;
  const text =
    state.status === 'offline' ? 'You are offline (simulated).' : state.status === 'connecting' ? 'Connecting' : 'Connection lost. Reconnecting';
  return (
    <div className={`conn-bar ${state.status}`} role="status">
      {text}
      {queued > 0 && ` · ${queued} queued, will send on reconnect`}
    </div>
  );
}

export function OfflineToggle({ state, setOnline }: { state: InboxState; setOnline: (on: boolean) => void }) {
  const off = state.status === 'offline';
  return (
    <button type="button" className="ghost" onClick={() => setOnline(off)} aria-pressed={off} title="Drop or restore the socket">
      {off ? <WifiSlash size={16} /> : <WifiHigh size={16} />}
      <span>{off ? 'Go online' : 'Go offline'}</span>
    </button>
  );
}
