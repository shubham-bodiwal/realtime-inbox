import { ChatCircleDots } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { AgentView } from './AgentView.tsx';
import { CustomerChat } from './CustomerChat.tsx';

const ROUTES = { '#/': 'Side by side', '#/agent': 'Agent', '#/widget': 'Customer' } as const;
type Route = keyof typeof ROUTES;
const current = (): Route => (location.hash in ROUTES ? (location.hash as Route) : '#/');

export function App() {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const on = () => setRoute(current());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <ChatCircleDots size={20} weight="fill" /> Realtime Inbox
        </a>
        <nav aria-label="Views">
          {(Object.keys(ROUTES) as Route[]).map((r) => (
            <a key={r} href={r} aria-current={r === route ? 'page' : undefined}>{ROUTES[r]}</a>
          ))}
        </nav>
      </header>
      <main className={`view view-${route.slice(2) || 'demo'}`}>
        {route === '#/' && (
          <>
            <AgentView />
            <CustomerChat />
          </>
        )}
        {route === '#/agent' && <AgentView />}
        {route === '#/widget' && <WidgetPage />}
      </main>
    </div>
  );
}

/** The widget as a customer would meet it: a launcher in the corner of someone else's page. */
function WidgetPage() {
  const [open, setOpen] = useState(true);
  return (
    <div className="host-page">
      <h1>Your storefront</h1>
      <p>This route mounts only the customer widget. Open it in a second browser or device to start another conversation; each browser gets its own customer id.</p>
      {open ? (
        <div className="launcher-panel"><CustomerChat onClose={() => setOpen(false)} /></div>
      ) : (
        <button type="button" className="launcher" aria-label="Open support chat" onClick={() => setOpen(true)}>
          <ChatCircleDots size={26} weight="fill" />
        </button>
      )}
    </div>
  );
}

