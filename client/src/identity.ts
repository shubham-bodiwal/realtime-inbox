import type { Identity } from './inbox.ts';

export const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export const AGENT: Identity = { userId: 'agent-mira', name: 'Mira', role: 'agent' };

const NAMES = ['Priya Raman', 'Jonas Becker', 'Lucía Ortega', 'Kenji Watanabe', 'Zanele Dube'];

/** One customer per browser, so a second tab or device shows up as a new conversation. */
export function customerIdentity(): Identity {
  try {
    const saved = localStorage.getItem('ri-customer');
    if (saved) return JSON.parse(saved);
  } catch {}
  const id = crypto.randomUUID().slice(0, 8);
  const me: Identity = { userId: `cust-${id}`, name: NAMES[parseInt(id, 16) % NAMES.length], role: 'customer' };
  try {
    localStorage.setItem('ri-customer', JSON.stringify(me));
  } catch {}
  return me;
}

export const initials = (name: string) =>
  name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
export const time = (ms: number) => fmt.format(ms);
