import { createServer } from 'node:http';
import { attachInbox } from './server.ts';
import { MemoryStore } from './store.ts';
import { customerConv } from '../../shared/protocol.ts';

const store = new MemoryStore();

// A few conversations so the agent view isn't empty on first run.
const seed: [string, string, string[]][] = [
  ['tomas-reyes', 'Tomás Reyes', ['Hi, my invoice for October shows two charges.', 'Order ref is 48213 if that helps.']],
  ['amara-osei', 'Amara Osei', ['Can I change the delivery address after checkout?']],
];
for (const [id, name, lines] of seed) {
  const conv = customerConv(id);
  store.ensureConversation(conv, id, name);
  lines.forEach((body, i) => store.append(conv, { clientId: `seed-${id}-${i}`, from: id, fromName: name, body }));
}

const http = createServer((_req, res) => res.writeHead(200).end('realtime-inbox ws server, connect to /ws\n'));
attachInbox(http, { store });
const port = Number(process.env.PORT ?? 8787);
http.listen(port, () => console.log(`ws://localhost:${port}/ws`));
