// Browser call server: serves public/, the dashboard API, and bridges one WebSocket per call to a
// Gemini Live session.
//   npm start            then open http://localhost:3000/call.html  (dashboard: /dashboard.html)
// Dashboard API (read-only; set DASHBOARD_TOKEN to require ?token= or a Bearer header):
//   GET /api/overview  /api/calls  /api/calls/:id  /api/guide  /api/curation  /api/stream (SSE)
// Wire protocol on /ws
//   browser → server  binary: 0x01 + JPEG frame, 0x02 + 16 kHz PCM16 mono audio
//                     text JSON: {type:'text', text} | {type:'audio_end'}
//   server → browser  binary: 24 kHz PCM16 mono agent audio
//                     text JSON: {type:'ready'|'transcript'|'card'|'event'|'error', ...}
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startLiveSession } from './agent/live-session.mjs';
import { paths as getPaths } from './config.mjs';
import { getCall, guideInfo, latestCuration, listCalls, overview } from './dashboard/api.mjs';
import { isErrorEvent, recordError } from './errors.mjs';
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

function sendJsonRes(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenOk(req, url, token) {
  if (!token) return true;
  const given = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function handleApi(req, res, url, { paths, bus, dashboardToken }) {
  if (!tokenOk(req, url, dashboardToken)) return sendJsonRes(res, 401, { error: 'token required' });
  if (req.method !== 'GET') return sendJsonRes(res, 405, { error: 'GET only' });
  const route = url.pathname.replace(/\/+$/, '');
  try {
    if (route === '/api/overview') return sendJsonRes(res, 200, overview(paths));
    if (route === '/api/calls') return sendJsonRes(res, 200, listCalls(paths, Math.min(Number(url.searchParams.get('limit')) || 50, 500)));
    if (route.startsWith('/api/calls/')) {
      const call = getCall(paths, decodeURIComponent(route.slice('/api/calls/'.length)));
      return call ? sendJsonRes(res, 200, call) : sendJsonRes(res, 404, { error: 'no such call' });
    }
    if (route === '/api/guide') return sendJsonRes(res, 200, guideInfo(paths));
    if (route === '/api/curation') return sendJsonRes(res, 200, latestCuration(paths));
    if (route === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      bus.on('event', send);
      req.on('close', () => { clearInterval(ping); bus.off('event', send); });
      return undefined;
    }
  } catch (err) {
    return sendJsonRes(res, 500, { error: err.message });
  }
  return sendJsonRes(res, 404, { error: 'unknown endpoint' });
}

/**
 * @param {object} [o]
 * @param {typeof startLiveSession} [o.startSession]  injectable for tests
 * @param {string} [o.publicDir]
 * @param {(e: object) => void} [o.log]
 * @param {ReturnType<typeof getPaths>} [o.paths]  where call logs and the guide live
 * @param {string} [o.dashboardToken]
 */
export function createCallServer({
  startSession = startLiveSession, publicDir = PUBLIC_DIR, log = () => {},
  paths = getPaths(), dashboardToken = process.env.DASHBOARD_TOKEN,
} = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  // Every call event goes to the log and to dashboard viewers. Only safe fields: tool args can hold caller details.
  const note = ({ type, sessionId, name, error, card }) => {
    log({ type, sessionId, name, error });
    if (isErrorEvent({ type, error })) recordError('server', { type, sessionId, name, error }, { paths });
    bus.emit('event', { t: new Date().toISOString(), type, sessionId, ...(name ? { name } : {}), ...(error ? { error } : {}), ...(card ? { card } : {}) });
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url, { paths, bus, dashboardToken });
    else serveStatic(req, res, publicDir);
  });
  server.bus = bus;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME + 1 });

  wss.on('connection', async (ws, req) => {
    const sessionId = randomUUID();
    const callerId = hashCaller(`${req.socket.remoteAddress}|${req.headers['user-agent'] || ''}`);
    const sendJson = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    // Say so plainly instead of relaying Google's "Permission denied on the service".
    if (startSession === startLiveSession && !process.env.GEMINI_API_KEY) {
      sendJson({ type: 'error', error: 'Genesis has no Gemini API key yet. Add GEMINI_API_KEY to .env and restart the server.' });
      log({ type: 'start_failed', sessionId, error: 'GEMINI_API_KEY missing' });
      ws.close();
      return;
    }
    let live = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      live?.close();
      if (ws.readyState === ws.OPEN) ws.close();
      note({ type: 'call_end', sessionId });
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
        paths,
        onAudio: (pcm) => { if (ws.readyState === ws.OPEN) ws.send(pcm, { binary: true }); },
        onTranscript: (t) => sendJson({ type: 'transcript', ...t }),
        onCard: (card) => { sendJson({ type: 'card', card }); note({ type: 'card', sessionId, card }); },
        onEvent: (e) => {
          // Tool args/results can hold caller details; the page only needs the event type and tool name.
          // Close reasons and errors come from the Gemini connection, not the caller, so they are safe to show.
          sendJson({ type: 'event', event: e.type, ...(e.name ? { name: e.name } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.error ? { error: e.error } : {}) });
          if (e.type === 'close') end();
          note({ sessionId, type: e.type, name: e.name, error: e.error });
        },
      });
    } catch (err) {
      sendJson({ type: 'error', error: `Could not start the agent: ${err.message}` });
      note({ type: 'start_failed', sessionId, error: err.message });
      end();
      return;
    }
    if (ended) { live.close(); return; }
    note({ type: 'call_start', sessionId });
    sendJson({ type: 'ready', sessionId });
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || undefined; // deploy sets 127.0.0.1 so only Caddy can reach it
  if (process.env.NODE_ENV === 'production' && !process.env.DASHBOARD_TOKEN) {
    console.error('Refusing to start: set DASHBOARD_TOKEN in production, or anyone with the URL can read call logs.');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) console.warn('GEMINI_API_KEY is not set: calls will fail to start until it is added to .env');
  if (process.env.MONGODB_URI) console.log('MongoDB mirror: on');
  createCallServer({
    // Only type/name/error: tool args can hold caller details.
    log: ({ type, sessionId, name, error }) => console.log(JSON.stringify({ type, sessionId, name, error })),
  }).listen(port, host, () => console.log(`Genesis call server: http://localhost:${port}/call.html · dashboard: http://localhost:${port}/dashboard.html`));
}
