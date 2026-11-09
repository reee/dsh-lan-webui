// dsh-lan-access — serve the Desktop Web UI on a LAN address behind its own
// authentication layer. Zero npm dependencies (Node builtins only).
//
// Architecture (see design-lan-web-access-plugin.md):
//   LAN client --[CIDR gate -> login cookie]--> this plugin's fixed listener
//     --reverse proxy: Host/Origin rewritten to loopback, launch token
//     injected on GET / and GET /connect, WebSocket upgrade piped--> the
//     official loopback webServer (its random port is read live).
//
// The official Host/Origin fence then sees a loopback authority, so the
// desktop profile needs no other config change. The launch token never
// reaches the LAN browser: the plugin session cookie gates everything.
import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';
import { connect as netConnect } from 'node:net';
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SESSION_COOKIE = 'dshlan_session';
const LOGIN_PATH = '/__lan/login';
const LOGOUT_PATH = '/__lan/logout';
const STATUS_PATH = '/__lan/status';
/** Same-origin settings endpoint on the official webServer (served to the in-app UI). */
const CONFIG_PATH = '/lan-access/config';
const MAX_CONFIG_BODY = 16 * 1024;
const MAX_LOGIN_BODY = 8 * 1024;
const MAX_LOCK_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;
/** Prefix of the official browser-session cookie (`dsh-auth-<sha256(authority)>`). */
const OFFICIAL_COOKIE_PREFIX = 'dsh-auth-';

// Arrow function on purpose: cordis classifies a plugin callback that has a
// `prototype` (any named function declaration) as a constructor plugin, calls
// it with `new`, and discards its return value — the lifecycle disposer would
// never run. Arrow functions have no prototype, so cordis calls this as a plain
// plugin and collects the returned disposer on fiber disposal.
const lanAccess = (ctx, rawConfig = {}) => {
  const log = makeLogger(ctx);
  // Machine-local settings live in $DSH_HOME/lan-access.json (written by
  // setup.js), so a bundle installed from npm/tarball needs no YAML editing.
  // An explicit entry config in the profile patch layer still wins — but then
  // the in-app page must refuse edits, since the patch would override them on
  // the next start.
  const patchConfig = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const patchConfigured = Object.keys(patchConfig).length > 0;
  const config = { ...(readHomeConfig(ctx, log) ?? {}), ...patchConfig };
  const cfg = validateConfig(config, log);
  let secret = loadSecret(ctx, log);
  if (!secret) return;
  const limiter = new Map();
  const liveSockets = new Set();
  const runtime = { listening: false, restartRequired: false };
  registerAdminRoute();

  // ---- internal (official loopback webServer) access -----------------------

  function internalInfo() {
    const ws = ctx.get('webServer');
    if (!ws || !ws.port) return undefined;
    return { port: ws.port, protocol: ws.protocol ?? 'http:' };
  }
  function launchToken(internal) {
    const conn = ctx.get('connection');
    if (!conn) return undefined;
    try {
      const url = new URL(conn.authenticatedUrl(`${internal.protocol}//127.0.0.1:${internal.port}`));
      return url.searchParams.get('token') ?? undefined;
    } catch {
      return undefined;
    }
  }
  function proxiedPath(rawUrl, internal, injectToken) {
    const url = new URL(rawUrl, 'http://lan.placeholder');
    if (injectToken) {
      const token = launchToken(internal);
      if (token) url.searchParams.set('token', token);
    }
    return url.pathname + url.search;
  }
  /**
   * Whether the request already carries the official browser-session cookie.
   * The official index route answers a token query with 303 `./` + a fresh
   * cookie, so injecting the token whenever that cookie is already present
   * would make every request redirect forever.
   */
  function hasOfficialCookie(req) {
    const raw = req.headers.cookie;
    if (!raw) return false;
    return raw.split(';').some((part) => part.split('=')[0].trim().startsWith(OFFICIAL_COOKIE_PREFIX));
  }
  function rewriteHeaders(headers, internal, keepConnection = false) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'origin') continue;
      if (lower === 'connection' && !keepConnection) continue;
      out[name] = value;
    }
    out.host = `127.0.0.1:${internal.port}`;
    if (headers.origin !== undefined) out.origin = `http://127.0.0.1:${internal.port}`;
    return out;
  }

  // ---- in-app settings (same-origin route on the official webServer) --------

  function configFile() {
    const home = resolveHome(ctx);
    return home ? join(home, 'lan-access.json') : join(dirname(fileURLToPath(import.meta.url)), '.lan-access.json');
  }
  /** What the in-app settings page may see (never the password hash). */
  function publicView(extra) {
    return {
      configured: Boolean(cfg),
      lanHost: cfg?.lanHost ?? null,
      port: cfg?.port ?? null,
      allowCidrs: cfg?.allowCidrTexts ?? [],
      hasPassword: Boolean(cfg?.passwordScrypt),
      cookieMaxAgeDays: cfg?.cookieMaxAgeDays ?? 7,
      listening: runtime.listening,
      restartRequired: runtime.restartRequired,
      patchOverrides: patchConfigured,
      configFile: configFile(),
      hosts: [...localAddresses()],
      ...(extra ?? {}),
    };
  }
  /**
   * Persist settings from the in-app page. Address/port changes need an app
   * restart (the listener bound at mount); password and allowlist changes apply
   * immediately. A password change also rotates the session secret, revoking
   * every existing LAN session.
   */
  function saveConfig(patch) {
    if (patchConfigured) {
      return { ok: false, error: 'settings are pinned by the profile patch (cordis.patch.yml); remove that entry config before editing here' };
    }
    const file = configFile();
    let existing = {};
    try {
      if (existsSync(file)) existing = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch {
      existing = {};
    }
    const next = { ...existing };
    if (patch.lanHost !== undefined) next.lanHost = String(patch.lanHost).trim();
    if (patch.port !== undefined) next.port = Number(patch.port);
    if (patch.allowCidrs !== undefined) {
      next.allowCidrs = Array.isArray(patch.allowCidrs)
        ? patch.allowCidrs.map((value) => String(value).trim()).filter(Boolean)
        : String(patch.allowCidrs).split(',').map((value) => value.trim()).filter(Boolean);
    }
    if (typeof patch.password === 'string' && patch.password.length > 0) {
      next.passwordScrypt = hashPassword(patch.password);
    }
    if (patch.cookieMaxAgeDays !== undefined) next.cookieMaxAgeDays = Number(patch.cookieMaxAgeDays);
    const problems = [];
    const candidate = validateConfig(next, (level, message) => problems.push(message));
    if (!candidate) return { ok: false, error: problems[problems.length - 1] ?? 'invalid settings' };
    const addressChanged = !cfg || candidate.lanHost !== cfg.lanHost || candidate.port !== cfg.port;
    const passwordChanged = Boolean(patch.password) && candidate.passwordScrypt !== cfg?.passwordScrypt;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    if (cfg) {
      // Password, allowlist and cookie lifetime always apply immediately; the
      // bound address/port stay as loaded because the listener is already bound.
      cfg.passwordScrypt = candidate.passwordScrypt;
      cfg.allowCidrs = candidate.allowCidrs;
      cfg.allowCidrTexts = candidate.allowCidrTexts;
      cfg.cookieMaxAgeDays = candidate.cookieMaxAgeDays;
    }
    if (passwordChanged) rotateSecret();
    if (addressChanged) runtime.restartRequired = true;
    return { ok: true, restartRequired: addressChanged, view: publicView() };
  }
  function rotateSecret() {
    const home = resolveHome(ctx);
    const file = home
      ? join(home, '.lan-access-secret')
      : join(dirname(fileURLToPath(import.meta.url)), '.lan-secret');
    const created = randomBytes(32);
    // Rotate in memory first: even if persisting fails, existing sessions must
    // die with the old password. A stale file only means the next start mints
    // another secret (and invalidates the sessions issued meanwhile).
    secret = created;
    log('info', 'password changed: existing LAN sessions were revoked');
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, created.toString('hex'), 'utf8');
    } catch (error) {
      log('warn', `cannot persist the rotated session secret at ${file}; sessions issued before the next restart will be rejected`, error);
    }
  }
  /** The route lives on the official server, so it must require the owner browser. */
  function isOwnerRequest(req) {
    const conn = ctx.get('connection');
    if (!conn || typeof conn.admit !== 'function') return false;
    try {
      const admission = conn.admit(req);
      return Boolean(admission) && !('rejection' in admission);
    } catch {
      return false;
    }
  }
  function registerAdminRoute() {
    // A plain ctx without cordis services (unit tests) has no inject; skip the
    // in-app route there. In the real Host this waits for the official
    // webServer service, because sibling plugins activate asynchronously.
    if (typeof ctx.inject !== 'function') return;
    ctx.inject(['webServer'], (webCtx) => {
      const handle = async (req, res) => {
        if (!isOwnerRequest(req)) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('unauthorized');
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(publicView()));
          return;
        }
        if (req.method === 'POST') {
          let body;
          try {
            body = JSON.parse(await readBody(req, MAX_CONFIG_BODY));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
            return;
          }
          const result = saveConfig(body && typeof body === 'object' ? body : {});
          res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(405);
        res.end();
      };
      const handler = (req, res) => {
        void handle(req, res).catch((error) => {
          log('error', 'in-app settings request failed', error);
          try {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          } catch { /* socket already gone */ }
        });
      };
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler }),
        'lan-access: in-app settings route',
      );
    });
  }

  // ---- plugin session (stateless signed cookie) ----------------------------

  const sessionMaxAgeMs = () => cfg.cookieMaxAgeDays * 24 * 60 * 60 * 1000;
  function makeSessionCookie() {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + sessionMaxAgeMs() })).toString('base64url');
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(sessionMaxAgeMs() / 1000)}`];
    if (cfg.tls) flags.push('Secure');
    return `${SESSION_COOKIE}=${payload}.${mac}; ${flags.join('; ')}`;
  }
  function readSessionCookie(req) {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const at = part.indexOf('=');
      if (at === -1) continue;
      if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
      return part.slice(at + 1).trim();
    }
    return undefined;
  }
  function sessionValid(req) {
    const value = readSessionCookie(req);
    if (!value) return false;
    const dot = value.indexOf('.');
    if (dot <= 0 || dot !== value.lastIndexOf('.')) return false;
    const payload = value.slice(0, dot);
    const mac = value.slice(dot + 1);
    const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest());
    let given;
    try {
      given = Buffer.from(Buffer.from(mac, 'base64url'));
    } catch {
      return false;
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof body.exp === 'number' && body.exp > Date.now();
    } catch {
      return false;
    }
  }

  // ---- password verification + rate limiting -------------------------------

  function verifyPassword(candidate) {
    const parts = cfg.passwordScrypt.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return Promise.resolve(false);
    const [tag, N, r, p, salt, hash] = parts;
    const params = { N: Number(N), r: Number(r), p: Number(p) };
    if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      scrypt(candidate.normalize('NFKC'), Buffer.from(salt, 'base64'), Buffer.from(hash, 'base64').length, params, (error, derived) => {
        if (error) return resolve(false);
        const expected = Buffer.from(hash, 'base64');
        resolve(derived.length === expected.length && timingSafeEqual(derived, expected));
      });
    });
  }
  function gateIp(ip) {
    const entry = limiter.get(ip);
    if (entry && entry.lockUntil > Date.now()) return { locked: true, retryInMs: entry.lockUntil - Date.now() };
    return { locked: false };
  }
  function noteFailure(ip) {
    const now = Date.now();
    const entry = limiter.get(ip) ?? { fails: 0, lockUntil: 0, updated: now };
    entry.updated = now;
    entry.fails += 1;
    if (entry.fails >= MAX_LOCK_FAILURES) {
      entry.lockUntil = now + LOCK_MS;
      entry.fails = 0;
    }
    limiter.set(ip, entry);
    if (limiter.size > 4096) {
      for (const [key, value] of limiter) {
        if (now - (value.updated ?? now) > 24 * 60 * 60 * 1000) limiter.delete(key);
      }
    }
    return Math.min(2 ** Math.min(entry.fails, 5) * 300, 6000);
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- request handling -----------------------------------------------------

  function clientIp(req) {
    const raw = req.socket.remoteAddress ?? '';
    if (raw.startsWith('::ffff:')) return raw.slice(7);
    return raw;
  }
  /** The only origin this listener serves; also used by the login CSRF guard. */
  const expectedOrigin = () => `${cfg.tls ? 'https' : 'http'}://${cfg.lanHost}:${cfg.port}`;
  function lanOriginMatches(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return false;
    try {
      return new URL(origin).origin === expectedOrigin();
    } catch {
      return false;
    }
  }
  /**
   * Defense in depth for the proxy hop: the official Host/Origin fence sees a
   * rewritten loopback origin, so a cross-site browser request that somehow
   * carried the cookies would not be rejected downstream. Reject it here.
   * Requests without an Origin header (curl, SDK clients) are allowed.
   */
  function requestOriginAllowed(req) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (new URL(origin).origin !== expectedOrigin()) return false;
      } catch {
        return false;
      }
    }
    return req.headers['sec-fetch-site'] !== 'cross-site';
  }
  function sendPage(res, status, html, extraHeaders = {}) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      ...extraHeaders,
    });
    res.end(html);
  }
  function loginPage(error) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 局域网访问</title>
<style>body{background:#14161a;color:#e6e6e6;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1d2025;border-radius:10px;padding:32px;width:min(92vw,360px)}h1{font-size:18px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #3a3f47;background:#14161a;color:#e6e6e6}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:6px;background:#4c8dff;color:#fff;font-size:15px;cursor:pointer}
.error{color:#ff7b72;font-size:14px;margin-top:10px}.foot{color:#8a919c;font-size:12px;margin-top:16px}</style></head>
<body><main><h1>DSH 局域网访问</h1><form method="post" action="${LOGIN_PATH}">
<input type="password" name="password" placeholder="密码" required autofocus autocomplete="current-password">
<button type="submit">登录</button>${error ? `<div class="error">${error}</div>` : ''}</form>
<div class="foot">未登录不会访问到 DSH 本体。</div></main></body></html>`;
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function proxyHttp(req, res) {
    const internal = internalInfo();
    if (!internal) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh webServer unavailable (is the desktop app fully started?)');
      return;
    }
    const url = new URL(req.url, 'http://lan.placeholder');
    // Only the clean index navigation needs the launch token: it trades the
    // token for the official cookie. Once that cookie exists (or if the URL
    // already carries a token), forward untouched.
    const isCleanIndex = req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token');
    const authenticated = hasOfficialCookie(req);
    forwardHttp(req, res, internal, isCleanIndex && !authenticated, isCleanIndex && authenticated);
  }
  /**
   * Forward one HTTP request. `allowTokenRetry` covers the stale-cookie cases:
   * the official cookie is bound to the loopback authority and to the signing
   * secret, so it dies whenever the desktop app restarts (its random port
   * changes) or the credential secret is rotated. A single retry carrying the
   * launch token recovers without user action.
   */
  function forwardHttp(req, res, internal, injectToken, allowTokenRetry) {
    const client = internal.protocol === 'https:' ? nodeHttps : nodeHttp;
    let settled = false;
    const request = client.request({
      host: '127.0.0.1',
      port: internal.port,
      method: req.method,
      path: proxiedPath(req.url, internal, injectToken),
      headers: rewriteHeaders(req.headers, internal),
    }, (response) => {
      if (allowTokenRetry && response.statusCode === 401) {
        settled = true;
        response.resume();
        forwardHttp(req, res, internal, true, false);
        return;
      }
      const headers = {};
      for (const [name, value] of Object.entries(response.headers)) {
        const lower = name.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'upgrade') continue;
        headers[name] = value;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
    });
    request.on('error', () => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh webServer request failed');
    });
    if (req.method === 'GET' || req.method === 'HEAD') request.end();
    else req.pipe(request);
  }
  function proxyUpgrade(req, socket, head) {
    const internal = internalInfo();
    if (!internal) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
      return;
    }
    const target = netConnect({ host: '127.0.0.1', port: internal.port }, () => {
      const headers = rewriteHeaders(req.headers, internal, true);
      const lines = [`${req.method} ${proxiedPath(req.url, internal, false)} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.on('close', () => target.destroy());
  }

  function onRequest(req, res) {
    const ip = clientIp(req);
    if (!ipAllowed(ip)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('address not allowed');
      return;
    }
    const path = new URL(req.url, 'http://lan.placeholder').pathname;
    if (path.startsWith('/__lan/')) {
      void handleLanRoute(req, res, ip, path).catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
      return;
    }
    if (!sessionValid(req)) {
      if ((req.headers.accept ?? '').includes('text/html')) {
        sendPage(res, 401, loginPage());
      } else {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('lan-access: sign in at /');
      }
      return;
    }
    if (req.method === 'CONNECT' || req.method === 'TRACE') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!requestOriginAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('cross-origin request rejected');
      return;
    }
    proxyHttp(req, res);
  }

  async function handleLanRoute(req, res, ip, path) {
    if (path === STATUS_PATH) {
      if (!sessionValid(req)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      const internal = internalInfo();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, internalPort: internal?.port ?? null, tls: cfg.tls }));
      return;
    }
    if (path === LOGOUT_PATH) {
      res.writeHead(303, { location: '/', 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
      res.end();
      return;
    }
    if (path === LOGIN_PATH && req.method === 'POST') {
      if (!lanOriginMatches(req)) {
        res.writeHead(400);
        res.end('bad origin');
        return;
      }
      const gate = gateIp(ip);
      if (gate.locked) {
        sendPage(res, 429, loginPage(`尝试过多，${Math.ceil(gate.retryInMs / 60000)} 分钟后再试`));
        return;
      }
      let body;
      try {
        body = await readBody(req, MAX_LOGIN_BODY);
      } catch {
        req.destroy();
        if (!res.headersSent) res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end();
        return;
      }
      const params = new URLSearchParams(body);
      const candidate = params.get('password') ?? '';
      const ok = await verifyPassword(candidate);
      if (!ok) {
        const delay = noteFailure(ip);
        log('warn', `login failure from ${ip}`);
        await sleep(delay);
        sendPage(res, 401, loginPage('密码错误'));
        return;
      }
      limiter.delete(ip);
      res.writeHead(303, { location: '/', 'set-cookie': makeSessionCookie() });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }

  function ipAllowed(ip) {
    if (cfg.allowCidrs.length === 0) return true;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false; // IPv4 only in v1
    const value = ipv4ToNumber(ip);
    if (value === undefined) return false;
    return cfg.allowCidrs.some((entry) => (value & entry.mask) === entry.base);
  }

  function onUpgrade(req, socket, head) {
    const ip = clientIp(req);
    if (!ipAllowed(ip) || !sessionValid(req) || !requestOriginAllowed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head);
  }

  // ---- lifecycle -------------------------------------------------------------

  // A fresh machine may have the plugin loaded before setup.js ran: keep the
  // in-app settings route available so the page can configure it, but no LAN
  // listener until a password exists.
  if (!cfg) {
    log('warn', 'LAN access is not configured yet; use Settings → 局域网访问 (or setup.js) to set a password and bind address.');
    return;
  }

  const server = cfg.tls
    ? nodeHttps.createServer({ cert: cfg.certPem, key: cfg.keyPem }, onRequest)
    : nodeHttp.createServer(onRequest);
  server.on('upgrade', onUpgrade);
  server.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
  });
  server.on('clientError', (error, socket) => socket.destroy());
  server.listen(cfg.port, cfg.lanHost, () => {
    runtime.listening = true;
    log('info', `listening on ${cfg.tls ? 'https' : 'http'}://${cfg.lanHost}:${cfg.port} (proxy -> loopback dsh webserver)`);
  });
  server.on('error', (error) => {
    runtime.listening = false;
    log('error', `LAN listener failed to bind ${cfg.lanHost}:${cfg.port}`, error);
  });
  // The disposer cordis collects on fiber disposal (disable / config reload).
  return () => {
    runtime.listening = false;
    server.close();
    for (const socket of liveSockets) socket.destroy();
    liveSockets.clear();
  };
};

export default lanAccess;

// ---- helpers ---------------------------------------------------------------

/** scrypt hash line the plugin's verification expects. */
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function ipv4ToNumber(text) {
  const parts = text.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
}
function parseCidr(text) {
  const [address, prefix] = String(text).split('/');
  const value = ipv4ToNumber(address);
  const bits = Number(prefix);
  if (value === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: value & mask, mask };
}
function localAddresses() {
  const out = new Set();
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' || info.family === 'IP4') out.add(info.address);
    }
  }
  return out;
}
function loadSecret(ctx, log) {
  // `dshHomePath` is the dsh-home-paths helper *function* (calling it with no
  // arguments returns the harness home), so accept that shape as well as a
  // plain string. Keeping the secret in the harness home survives plugin
  // reinstalls; the plugin directory is only a fallback.
  const home = resolveHome(ctx);
  const file = typeof home === 'string' && home.length > 0
    ? join(home, '.lan-access-secret')
    : join(dirname(fileURLToPath(import.meta.url)), '.lan-secret');
  try {
    if (existsSync(file)) {
      const hex = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    }
    const created = randomBytes(32);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, created.toString('hex'), 'utf8');
    return created;
  } catch (error) {
    log('error', `cannot read/write session secret at ${file}`, error);
    return undefined;
  }
}
function resolveHome(ctx) {
  try {
    const service = ctx.get('dshHomePath');
    if (typeof service === 'function') {
      const value = service();
      return typeof value === 'string' ? value : undefined;
    }
    return typeof service === 'string' ? service : undefined;
  } catch {
    return undefined;
  }
}
/** Machine-local settings written by setup.js; absent means "use patch config". */
function readHomeConfig(ctx, log) {
  const home = resolveHome(ctx);
  if (typeof home !== 'string' || home.length === 0) return undefined;
  const file = join(home, 'lan-access.json');
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log('warn', `ignoring ${file}: expected a JSON object`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    log('warn', `ignoring unreadable ${file}`, error);
    return undefined;
  }
}
/** First non-internal IPv4, preferring RFC1918 ranges. */
function detectLanHost() {
  const candidates = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if ((info.family === 'IPv4' || info.family === 'IP4') && !info.internal && info.address) candidates.push(info.address);
    }
  }
  const pick = (re) => candidates.find((address) => re.test(address));
  return pick(/^192\.168\./) ?? pick(/^10\./) ?? pick(/^172\.(?:1[6-9]|2\d|3[01])\./) ?? candidates[0];
}
function hostCidr(host) {
  const value = ipv4ToNumber(host);
  if (value === undefined) return undefined;
  return `${host.split('.').slice(0, 3).join('.')}.0/24`;
}
function validateConfig(raw, log) {
  if (raw.enabled === false) {
    log('info', 'disabled by config');
    return undefined;
  }
  let lanHost = typeof raw.lanHost === 'string' ? raw.lanHost.trim() : undefined;
  if (lanHost === undefined || lanHost === '' || lanHost === 'auto') lanHost = detectLanHost();
  const cfg = {
    lanHost,
    port: raw.port === undefined ? 3443 : Number(raw.port),
    passwordScrypt: typeof raw.passwordScrypt === 'string' ? raw.passwordScrypt : undefined,
    cookieMaxAgeDays: Number.isInteger(raw.cookieMaxAgeDays) && raw.cookieMaxAgeDays >= 1 && raw.cookieMaxAgeDays <= 90
      ? raw.cookieMaxAgeDays : 7,
    allowCidrs: [],
    allowCidrTexts: [],
    tls: false,
    certPem: undefined,
    keyPem: undefined,
  };
  if (!cfg.lanHost || !localAddresses().has(cfg.lanHost)) {
    log('error', `lanHost ${JSON.stringify(cfg.lanHost)} is not one of this machine's IPv4 addresses (${[...localAddresses()].join(', ')}); set lanHost in $DSH_HOME/lan-access.json (setup.js) or the profile patch`);
    return undefined;
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    log('error', 'port must be an integer in 1..65535');
    return undefined;
  }
  if (!cfg.passwordScrypt || cfg.passwordScrypt.split('$').length !== 6) {
    log('warn', 'not configured yet: run setup.js for this machine to write $DSH_HOME/lan-access.json (password + lanHost)');
    return undefined;
  }
  // Explicit allowCidrs (including an empty list = no IP restriction) wins;
  // otherwise default to this host's /24 plus the Tailscale CGNAT range.
  if (Array.isArray(raw.allowCidrs)) {
    for (const text of raw.allowCidrs) {
      const entry = parseCidr(text);
      if (!entry) {
        log('error', `allowCidrs entry ${JSON.stringify(text)} is not IPv4 CIDR`);
        return undefined;
      }
      cfg.allowCidrs.push(entry);
      cfg.allowCidrTexts.push(String(text).trim());
    }
  } else {
    const subnet = hostCidr(cfg.lanHost);
    for (const text of [subnet, '100.64.0.0/10']) {
      const entry = text ? parseCidr(text) : undefined;
      if (entry) {
        cfg.allowCidrs.push(entry);
        cfg.allowCidrTexts.push(text);
      }
    }
  }
  if (typeof raw.tlsCert === 'string' && typeof raw.tlsKey === 'string') {
    try {
      cfg.certPem = readFileSync(raw.tlsCert);
      cfg.keyPem = readFileSync(raw.tlsKey);
      cfg.tls = true;
    } catch (error) {
      log('error', 'cannot read tls cert/key files', error);
      return undefined;
    }
  } else if (typeof raw.tlsCert === 'string' || typeof raw.tlsKey === 'string') {
    log('error', 'tlsCert and tlsKey must be provided together');
    return undefined;
  }
  if (!cfg.tls) log('info', 'http (no TLS) - fine over Tailscale; add tlsCert/tlsKey for plain Wi-Fi direct use');
  return cfg;
}
function makeLogger(ctx) {
  const cordis = typeof ctx.root?.logger === 'function' ? ctx.root.logger('lan-access') : undefined;
  return (level, message, error) => {
    const text = `[lan-access] ${message}`;
    if (cordis?.[level]) cordis[level](error ? `${text}: ${error.message}` : text);
    else if (level === 'error') console.error(text, error ?? '');
    else console.warn(text);
  };
}
