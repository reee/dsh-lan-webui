// Unit-level smoke test for dsh-lan-access against a dumb echo stand-in for the
// internal web server. Covers auth, gating, header rewriting and proxying.
// The faithful handshake (token -> 303 -> official cookie) lives in
// official_sim.mjs; the real-cordis lifecycle lives in cordis_integration.mjs.
// Run: bundled node --expose-internals smoke_test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect } from 'node:net';
import { rmSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import lanAccess from '../index.js';

const INTERNAL = 39000 + Math.floor(Math.random() * 500);
const LAN = 39500 + Math.floor(Math.random() * 500);
const PASSWORD = 'smoke-test-pw-123';

const internal = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-echo=1; Path=/' });
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin ?? null,
      cookie: req.headers.cookie ?? null,
    }));
  });
});
internal.on('upgrade', (req, socket) => {
  socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nWSOK path=${req.url} host=${req.headers.host} origin=${req.headers.origin ?? '-'} conn=${req.headers.connection ?? '-'}`);
});
await new Promise((r) => internal.listen(INTERNAL, '127.0.0.1', r));

const salt = randomBytes(16);
const hash = scryptSync(PASSWORD, salt, 32, { N: 16384, r: 8, p: 1 });
const SESSION_HOME = fileURLToPath(new URL('./.test-secret-home/', import.meta.url));
const dispose = lanAccess({
  get: (key) => (key === 'webServer' ? { port: INTERNAL, protocol: 'http:' }
    : key === 'connection' ? { authenticatedUrl: (base) => `${base}/?token=TOK123` }
      : key === 'dshHomePath' ? SESSION_HOME : undefined),
  root: {},
  on: () => {},
}, {
  lanHost: '127.0.0.1',
  port: LAN,
  passwordScrypt: `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`,
  allowCidrs: ['127.0.0.0/8'],
  cookieMaxAgeDays: 7,
});

const base = `http://127.0.0.1:${LAN}`;
for (let i = 0; i < 50; i++) {
  const ok = await new Promise((resolve) => {
    const s = connect(LAN, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  if (ok) break;
  await new Promise((r) => setTimeout(r, 40));
}
const pass = (name) => console.log('PASS', name);

// a) unauthenticated navigation -> 401 login page
let res = await fetch(`${base}/`, { headers: { accept: 'text/html,*/*' } });
assert.equal(res.status, 401);
assert.match(await res.text(), /DSH 局域网访问/);
pass('unauth navigation -> login page');

// b) unauthenticated API request -> 401 text
res = await fetch(`${base}/some/api`);
assert.equal(res.status, 401);
pass('unauth api -> 401');

// c) login without Origin -> 400 (CSRF guard)
res = await fetch(`${base}/__lan/login`, { method: 'POST', body: new URLSearchParams({ password: PASSWORD }) });
assert.equal(res.status, 400);
pass('login without Origin -> 400 (CSRF guard)');

// c2) login with a foreign Origin -> 400
res = await fetch(`${base}/__lan/login`, {
  method: 'POST', headers: { origin: 'http://evil.example' },
  body: new URLSearchParams({ password: PASSWORD }),
});
assert.equal(res.status, 400);
pass('login from foreign Origin -> 400');

// d) wrong password -> 401
res = await fetch(`${base}/__lan/login`, {
  method: 'POST', headers: { origin: base },
  body: new URLSearchParams({ password: 'wrong' }),
});
assert.equal(res.status, 401);
pass('wrong password -> 401');

// e) correct password -> 303 + HttpOnly session cookie
res = await fetch(`${base}/__lan/login`, {
  method: 'POST', headers: { origin: base },
  body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual',
});
assert.equal(res.status, 303);
const setCookie = res.headers.get('set-cookie');
assert.ok(setCookie?.startsWith('dshlan_session='));
assert.ok(setCookie.includes('HttpOnly'));
assert.ok(setCookie.includes('SameSite=Lax'));
const sessionCookie = setCookie.split(';')[0];
pass('login -> 303 + HttpOnly session cookie');

// f) authenticated GET / without an official cookie -> token injected, Host rewritten
res = await fetch(`${base}/`, { headers: { cookie: sessionCookie } });
assert.equal(res.status, 200);
let echoed = await res.json();
assert.equal(echoed.url, '/?token=TOK123');
assert.equal(echoed.host, `127.0.0.1:${INTERNAL}`);
assert.equal(echoed.origin, null);
pass('GET / -> token injected, Host rewritten to loopback');

// g) once the official cookie exists, / is forwarded without a token
res = await fetch(`${base}/`, { headers: { cookie: `${sessionCookie}; dsh-auth-stale=abc.def` } });
echoed = await res.json();
assert.equal(echoed.url, '/');
pass('GET / with official cookie -> no token (no redirect loop)');

// h) authenticated deep path -> forwarded verbatim
res = await fetch(`${base}/some/path?x=1`, { headers: { cookie: sessionCookie } });
echoed = await res.json();
assert.equal(echoed.url, '/some/path?x=1');
pass('GET /some/path?x=1 -> forwarded verbatim');

// i) internal Set-Cookie passes through to the LAN browser
assert.match(res.headers.get('set-cookie') ?? '', /dsh-auth-echo=1/);
pass('internal set-cookie passes through');

// j) cross-origin authenticated request -> 403
res = await fetch(`${base}/`, { headers: { cookie: sessionCookie, origin: 'http://evil.example' } });
assert.equal(res.status, 403);
pass('cross-origin request -> 403');

// k) WebSocket upgrade: gated, then piped with rewritten Host/Origin
function rawUpgrade(cookieHeader, origin) {
  return new Promise((resolve, reject) => {
    const s = connect(LAN, '127.0.0.1', () => {
      s.write(
        'GET /api HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${LAN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        (origin ? `Origin: ${origin}\r\n` : '') +
        (cookieHeader ? `Cookie: ${cookieHeader}\r\n` : '') + '\r\n',
      );
    });
    let data = '';
    s.on('data', (c) => { data += c; });
    s.on('close', () => resolve(data));
    s.on('error', reject);
    setTimeout(() => s.destroy(), 400);
  });
}
let raw = await rawUpgrade(sessionCookie, base);
assert.match(raw, /101 Switching Protocols/, raw);
assert.match(raw, new RegExp(`host=127\\.0\\.0\\.1:${INTERNAL}`), raw);
assert.match(raw, /origin=http:\/\/127\.0\.0\.1:/, raw);
assert.match(raw, /conn=Upgrade/, raw);
assert.doesNotMatch(raw, /TOK123/);
pass('WS upgrade piped: Host/Origin rewritten, no token, Connection kept');

raw = await rawUpgrade('', base);
assert.match(raw, /401 Unauthorized/, raw);
pass('WS upgrade without session -> 401');

raw = await rawUpgrade(sessionCookie, 'http://evil.example');
assert.match(raw, /401 Unauthorized/, raw);
pass('WS upgrade from foreign origin -> 401');

// l) status endpoint
res = await fetch(`${base}/__lan/status`, { headers: { cookie: sessionCookie } });
assert.equal(res.status, 200);
const status = await res.json();
assert.equal(status.ok, true);
assert.equal(status.internalPort, INTERNAL);
pass('status endpoint');

// m) tampered session rejected
const [payload, mac] = sessionCookie.split('=')[1].split('.');
const evil = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 9e15 })).toString('base64url');
res = await fetch(`${base}/`, { headers: { cookie: `dshlan_session=${evil}.${mac}` } });
assert.equal(res.status, 401);
pass('tampered session cookie rejected');

// n) logout clears the cookie
res = await fetch(`${base}/__lan/logout`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
assert.equal(res.status, 303);
assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/);
pass('logout clears session');

// o) returned disposer closes the listener (cordis collects it)
dispose();
await new Promise((r) => setTimeout(r, 100));
await assert.rejects(() => fetch(`${base}/__lan/status`));
pass('disposer -> LAN listener closed');

internal.close();
internal.closeAllConnections?.();
rmSync(SESSION_HOME, { recursive: true, force: true });
console.log('\nALL SMOKE CHECKS PASSED');
// Let the event loop drain instead of process.exit(): exiting while libuv
// closes async handles can abort the process on Windows.

