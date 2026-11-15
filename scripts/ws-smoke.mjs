// End-to-end check of the browser call path with the real Gemini Live model, no browser needed.
// Starts the call server, connects like call.html does, sends the fixture frame and a question,
// and expects agent audio back.
//   npm run ws-smoke          (needs GEMINI_API_KEY in .env)
import { once } from 'node:events';
import fs from 'node:fs';
import WebSocket from 'ws';
import { createCallServer } from '../src/server.mjs';

if (!process.env.GEMINI_API_KEY) { console.error('Set GEMINI_API_KEY (.env)'); process.exit(1); }

const frame = fs.readFileSync(new URL('../test/fixtures/monitor-wrong-port.jpg', import.meta.url));
const server = createCallServer();
server.listen(0);
await once(server, 'listening');
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);

let audioBytes = 0;
let agent = '';
const done = (code, msg) => { console.log(msg); ws.close(); server.close(); process.exit(code); };
const timer = setTimeout(() => done(1, `✗ timed out (audio bytes: ${audioBytes})`), 45000);

ws.on('message', (data, isBinary) => {
  if (isBinary) { audioBytes += data.length; return; }
  const msg = JSON.parse(String(data));
  if (msg.type === 'error') { clearTimeout(timer); done(1, `✗ ${msg.error}`); }
  if (msg.type === 'ready') {
    console.log(`Connected, session ${msg.sessionId}`);
    ws.send(Buffer.concat([Buffer.from([0x01]), frame]));
    ws.send(JSON.stringify({ type: 'text', text: 'My monitor says no signal. This is the back of it. What is wrong?' }));
  }
  if (msg.type === 'transcript' && msg.role === 'agent') agent += msg.text;
  if (msg.type === 'card') console.log(`  card: ${msg.card.title} → ${msg.card.steps.join(' | ')}`);
  if (msg.type === 'event' && msg.event === 'turn_complete' && audioBytes > 0) {
    clearTimeout(timer);
    done(0, `  Genesis: ${agent.trim()}\n✓ ${audioBytes} bytes of agent audio (${(audioBytes / 48000).toFixed(1)} s)`);
  }
});
