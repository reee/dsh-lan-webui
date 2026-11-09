// End-to-end simulation of dsh-lan-access against a faithful stand-in for the
// official loopback web server. The stand-in mirrors the real handshake:
//   GET /?token=<ok>        -> 303 Location: ./  + Set-Cookie dsh-auth-<sha256(host)>
//   GET /  with valid cookie-> 200 index (HTML)
//   GET /api (WebSocket)    -> 101 only with a valid cookie
//   anything else           -> 401
// Run: bundled node --expose-internals official_sim.mjs
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { connect } from 'node:net';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import lanAccess from '../index.js';

const SECRET = Buffer.from('sim-secret-0123456789abcdef0123456789ab');
const LAN = 34000 + Math.floor(Math.random() * 1000); // ephemeral test port
let token = 'TOKEN-1';
let internalPort = 41000 + Math.floor(Math.random() * 1000);

const cookieName = (authority) => 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
const hmac = (payload) => createHmac('sha256', SECRET).update(payload).digest('base64url');
const makeCookieValue = () => {
  const payload = Buffer.from(JSON.stringify({ authority: 'x', exp: Date.now() + 86400000 })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
};
const cookieJar = new Map(); // name -> value (browser-per-origin jar)
const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
function absorbSetCookie(headers) {
  for (const raw of headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    const at = pair.indexOf('=');
    cookieJar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}
const validCookie = (req) => {
  const host = req.headers.host ?? '';
  const name = cookieName(host);
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    const [p, m] = part.slice(at + 1).trim().split('.');
    return typeof p === 'string' && m === hmac(p);
  }
  return false;
};

const internalHandler = (req, res) => {
  const host = req.headers.host ?? '';
  const url = new URL(req.url ?? '/', 'http://dsh.invalid');
  if (req.method === 'GET' && url.pathname === '/') {
    const tokens = url.searchParams.getAll('token');
    if (tokens.length === 1 && tokens[0] === token) {
      res.writeHead(303, {
        location: './',
        'set-cookie': `${cookieName(host)}=${makeCookieValue()}; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }
    if (validCookie(req)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>DSH INDEX</html>');
      return;
    }
  }
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('dsh web authentication required');
};
const internalUpgrade = (req, socket) => {
  if (!validCookie(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
};
let internal = createServer(internalHandler);
internal.on('upgrade', internalUpgrade);
await new Promise((r) => internal.listen(internalPort, '127.0.0.1', r));

// ---- mount plugin with a mutable stub ctx (port/token can change) ----------
const SESSION_HOME = fileURLToPath(new URL('./.test-secret-home/', import.meta.url));
const password = 'sim-pass-123';
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
const disposers = [];
const dispose = lanAccess({
  get: (key) => (key === 'webServer' ? { port: internalPort, protocol: 'http:' }
    : key === 'connection' ? { authenticatedUrl: (base) => `${base}/?token=${token}` }
      : key === 'dshHomePath' ? SESSION_HOME
        : undefined),
  root: {},
  on: () => {},
}, {
  lanHost: '127.0.0.1', port: LAN,
  passwordScrypt: `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`,
  allowCidrs: [],
});

const base = `http://127.0.0.1:${LAN}`;
for (let i = 0; i < 50; i++) {
  const ok = await new Promise((resolve) => {
    const s = connect(LAN, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  if (ok) break;
  await new Promise((r) => setTimeout(r, 50));
}

const pass = (name) => console.log('PASS', name);

// login
let res = await fetch(`${base}/__lan/login`, {
  method: 'POST', headers: { origin: base },
  body: new URLSearchParams({ password }), redirect: 'manual',
});
assert.equal(res.status, 303);
cookieJar.set('dshlan_session', res.headers.getSetCookie()[0].split(';')[0].split('=').slice(1).join('='));
pass('login sets plugin session cookie');

// browser-like navigation helper: follow redirects, absorb cookies
async function navigate(pathname, opts = {}) {
  let url = base + pathname;
  const chain = [];
  for (let hop = 0; hop < 6; hop++) {
    const r = await fetch(url, {
      headers: { cookie: cookieHeader(), accept: 'text/html', ...(opts.headers ?? {}) },
      redirect: 'manual',
    });
    chain.push(r.status);
    absorbSetCookie(r.headers);
    if (r.status >= 300 && r.status < 400) {
      url = new URL(r.headers.get('location'), url).href;
      continue;
    }
    return { status: r.status, body: await r.text(), chain };
  }
  return { status: 0, body: '', chain };
}

// A. fresh navigation: token hop then index
let nav = await navigate('/');
assert.equal(nav.status, 200, JSON.stringify(nav));
assert.match(nav.body, /DSH INDEX/);
assert.deepEqual(nav.chain, [303, 200], JSON.stringify(nav.chain));
pass('fresh navigation: token 303 then index 200 (no loop)');

// B. second navigation reuses the official cookie: single hop
nav = await navigate('/');
assert.equal(nav.status, 200);
assert.deepEqual(nav.chain, [200]);
pass('repeat navigation: official cookie reused, single request');

// C. desktop restart: new random port + new launch token; stale cookie must recover
await new Promise((r) => { internal.close(r); internal.closeAllConnections?.(); });
internalPort = 41000 + Math.floor(Math.random() * 1000);
token = 'TOKEN-2';
internal = createServer(internalHandler);
internal.on('upgrade', internalUpgrade);
await new Promise((r) => internal.listen(internalPort, '127.0.0.1', r));
nav = await navigate('/');
assert.equal(nav.status, 200, JSON.stringify(nav));
assert.deepEqual(nav.chain, [303, 200], JSON.stringify(nav.chain));
pass('restart (new port + token): stale cookie recovered via token retry');

// D. cross-origin browser request is rejected before proxying
res = await fetch(`${base}/`, {
  headers: { cookie: cookieHeader(), origin: 'http://evil.example' },
  redirect: 'manual',
});
assert.equal(res.status, 403);
pass('cross-origin request -> 403');

// E. WebSocket upgrade: authenticated origin allowed, unauthenticated rejected
function upgrade(cookie, origin) {
  return new Promise((resolve, reject) => {
    const s = connect(LAN, '127.0.0.1', () => {
      s.write(
        'GET /api HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${LAN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        (origin ? `Origin: ${origin}\r\n` : '') +
        (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n',
      );
    });
    let data = '';
    s.on('data', (c) => { data += c; });
    s.on('close', () => resolve(data));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); }, 300);
  });
}
let raw = await upgrade(cookieHeader(), base);
assert.match(raw, /101 Switching Protocols/, raw);
pass('WS upgrade with session+origin -> proxied 101');

raw = await upgrade('', base);
assert.match(raw, /401 Unauthorized/, raw);
pass('WS upgrade without session -> 401');

raw = await upgrade(cookieHeader(), 'http://evil.example');
assert.match(raw, /401 Unauthorized/, raw);
pass('WS upgrade from foreign origin -> 401');

// F. session-authenticated non-browser client (curl, no Origin) reaches the index
res = await fetch(`${base}/`, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
assert.equal(res.status, 200);
pass('curl-like request (no Origin) served');

dispose();
internal.close();
internal.closeAllConnections?.();
rmSync(SESSION_HOME, { recursive: true, force: true });
console.log('\nALL E2E CHECKS PASSED');
// No process.exit(): exiting while libuv closes async handles can abort the
// process on Windows; with the listener disposed the loop drains by itself.

