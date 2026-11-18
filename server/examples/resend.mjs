// Speaks the protocol by hand: hello, join, then sends the same message twice
// with one clientId, as a client would when retrying. Run with `pnpm dev` up:
//   node server/examples/resend.mjs
import WebSocket from 'ws';

const conv = 'conv_cust-demo';
const message = { t: 'send', conv, clientId: 'c1', body: 'Hi, where is my order?' };
const ws = new WebSocket(process.env.WS_URL ?? 'ws://localhost:8787/ws');
let acks = 0;

const send = (frame) => {
  console.log('>', JSON.stringify(frame));
  ws.send(JSON.stringify(frame));
};

ws.on('open', () => send({ t: 'hello', userId: 'cust-demo', name: 'Dana', role: 'customer' }));
ws.on('message', (raw) => {
  const frame = JSON.parse(String(raw));
  console.log('<', JSON.stringify(frame));
  if (frame.t === 'welcome') send({ t: 'join', conv, since: 0 });
  if (frame.t === 'history') send(message);
  if (frame.t === 'ack' && ++acks === 1) send(message);
  else if (frame.t === 'ack') ws.close();
});
