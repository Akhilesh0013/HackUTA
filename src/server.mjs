// Browser call server: serves public/ and bridges one WebSocket per call to a Gemini Live session.
//   npm start            then open http://localhost:3000/call.html
// Wire protocol on /ws
//   browser → server  binary: 0x01 + JPEG frame, 0x02 + 16 kHz PCM16 mono audio
//                     text JSON: {type:'text', text} | {type:'audio_end'}
//   server → browser  binary: 24 kHz PCM16 mono agent audio
//                     text JSON: {type:'ready'|'transcript'|'card'|'event'|'error', ...}
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startLiveSession } from './agent/live-session.mjs';
import { hashCaller } from './tools/handlers.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_FRAME = 1_000_000; // a 512 px JPEG is ~50 KB
const MAX_AUDIO = 64_000;    // 2 s of 16 kHz PCM16
const MAX_TEXT = 2_000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const FRAME = 0x01;
const AUDIO = 0x02;

function serveStatic(req, res, publicDir) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'call.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/**
 * @param {object} [o]
 * @param {typeof startLiveSession} [o.startSession]  injectable for tests
 * @param {string} [o.publicDir]
 * @param {(e: object) => void} [o.log]
 */
export function createCallServer({ startSession = startLiveSession, publicDir = PUBLIC_DIR, log = () => {} } = {}) {
  const server = http.createServer((req, res) => serveStatic(req, res, publicDir));
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME + 1 });

  wss.on('connection', async (ws, req) => {
    const sessionId = randomUUID();
    const callerId = hashCaller(`${req.socket.remoteAddress}|${req.headers['user-agent'] || ''}`);
    const sendJson = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    let live = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      live?.close();
      if (ws.readyState === ws.OPEN) ws.close();
      log({ type: 'call_end', sessionId });
    };
    ws.on('close', end);

    // Validate every message: the browser is untrusted.
    ws.on('message', (data, isBinary) => {
      if (!live) return; // not ready yet; the page waits for {type:'ready'}
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        const kind = buf[0];
        const body = buf.subarray(1);
        if (kind === FRAME && body.length > 2 && body.length <= MAX_FRAME && body[0] === 0xff && body[1] === 0xd8) live.sendFrame(body);
        else if (kind === AUDIO && body.length > 0 && body.length <= MAX_AUDIO && body.length % 2 === 0) live.sendAudio(body);
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg?.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) live.sendText(msg.text.slice(0, MAX_TEXT));
      else if (msg?.type === 'audio_end') live.endAudio?.();
    });

    try {
      live = await startSession({
        sessionId,
        callerId,
        onAudio: (pcm) => { if (ws.readyState === ws.OPEN) ws.send(pcm, { binary: true }); },
        onTranscript: (t) => sendJson({ type: 'transcript', ...t }),
        onCard: (card) => sendJson({ type: 'card', card }),
        onEvent: (e) => {
          // Tool args/results can hold caller details; the page only needs the event type and tool name.
          // Close reasons and errors come from the Gemini connection, not the caller, so they are safe to show.
          sendJson({ type: 'event', event: e.type, ...(e.name ? { name: e.name } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.error ? { error: e.error } : {}) });
          if (e.type === 'close') end();
          log({ sessionId, ...e });
        },
      });
    } catch (err) {
      sendJson({ type: 'error', error: `Could not start the agent: ${err.message}` });
      log({ type: 'start_failed', sessionId, error: err.message });
      end();
      return;
    }
    if (ended) { live.close(); return; }
    log({ type: 'call_start', sessionId });
    sendJson({ type: 'ready', sessionId });
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 3000;
  if (!process.env.GEMINI_API_KEY) console.warn('GEMINI_API_KEY is not set: calls will fail to start until it is added to .env');
  createCallServer({
    // Only type/name/error: tool args can hold caller details.
    log: ({ type, sessionId, name, error }) => console.log(JSON.stringify({ type, sessionId, name, error })),
  }).listen(port, () => console.log(`Genesis call server: http://localhost:${port}/call.html`));
}
