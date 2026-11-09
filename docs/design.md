# Design and threat model

## Why a second listener

The DSH desktop host starts its Web server on `127.0.0.1` with a random port and a
per-process launch token, and its Host/Origin fence only trusts loopback authorities.
That is deliberate: the Web UI can run commands, so exposing it must be an explicit,
authenticated decision.

This plugin therefore runs its own listener on one chosen IPv4 address and reverse
proxies to the loopback server. The official server never changes; the only new
surface is the plugin's authenticated listener.

```
LAN client
  └─ plugin listener (http(s)://<lan-ip>:3443)
       ├─ IPv4 CIDR allowlist            (before auth)
       ├─ password login → signed cookie (scrypt, HMAC-SHA256, HttpOnly)
       ├─ Origin / Sec-Fetch-Site gate   (cross-site rejected)
       └─ reverse proxy ──► 127.0.0.1:<random port>
            ├─ Host/Origin rewritten to loopback
            ├─ launch token injected on GET / (loopback hop only)
            ├─ WebSocket upgrades piped for /api/remote.mux
            └─ stale official cookie recovered with one token retry
```

## Authentication handshake

1. LAN browser signs in to the plugin (password → `dshlan_session` cookie).
2. The proxy injects the process launch token on the first `GET /`.
3. The official server answers `303 ./` and mints its own `dsh-auth-<hash>` cookie;
   the browser follows to a clean `/`.
4. Subsequent requests carry the official cookie; the proxy forwards them untouched.
5. After a restart the official cookie dies (port/secret change): the proxy sees
   `401` and retries once with the token, re-minting the cookie without user action.

Injecting the token only when the official cookie is absent avoids the redirect loop
that would otherwise occur on every `/` request.

## Settings page data path

The page is a hand-written client bundle (`window.__ModuleLoader__.load`) registered
into the `settings.section` slot. It talks to `GET/POST /lan-access/config`, a
same-origin route on the official server that:

- admits only the owner browser (`connection.admit`),
- returns the effective view without the password hash,
- writes `$DSH_HOME/lan-access.json`, applying password/allowlist changes live and
  flagging address/port changes as restart-required,
- refuses writes while the profile patch pins the configuration.

## Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| Anyone on the network reaches the UI | CIDR allowlist + password + lockout | weak password guessable online (lockout slows it) |
| Plain-text sniffing | Tailscale/WireGuard on the WAN leg; optional TLS | Wi-Fi direct without TLS |
| Token leak | token only on the loopback proxy hop; never in the browser URL | host compromise |
| Session hijack | HttpOnly + SameSite=Lax (+Secure with TLS); password change rotates the secret | XSS on the served app |
| CSRF | SameSite cookies + Origin gate at the proxy hop | — |
| Settings abuse | owner-cookie admission, hash never returned | LAN login is owner-equivalent by design |

The single-owner DSH design means a LAN login is equivalent to full machine control.
Operators must treat the LAN password as a machine credential.
