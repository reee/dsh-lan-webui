# Security

This plugin deliberately exposes a DeepSeek Harness instance over the network, so
please read this before enabling it.

## What access means

The DSH Host is single-owner: every browser that completes the LAN login shares the
**same owner peer**. A successful LAN login therefore grants **full control over the
DSH instance**, including running commands on the machine. Treat the LAN password as
a machine-level credential.

## What the plugin does to reduce risk

- **Never binds `0.0.0.0`.** The listener binds exactly one IPv4 address you choose.
- **Password authentication** (scrypt, N=16384, r=8, p=1) before any request reaches
  the official server; the password hash never leaves the Host.
- **IP allowlist** (IPv4 CIDR) evaluated before authentication.
- **Rate limiting**: failures slow down and lock out per IP (10 failures → 15 min).
- **Signed session cookie**: HttpOnly, SameSite=Lax, random 256-bit HMAC secret stored
  in `$DSH_HOME/.lan-access-secret`; changing the password rotates it and logs out all
  LAN devices.
- **The official launch token never reaches the browser.** It is injected only on the
  loopback proxy hop used to mint the official cookie.
- **Cross-site protection** at the proxy hop: mismatched `Origin` and
  `Sec-Fetch-Site: cross-site` are rejected before proxying.
- **Same-origin settings route** requires the official owner cookie; it never returns
  the password hash.

## Residual risks (accepted by the operator)

- Anyone with the password and an allowed source address has full control.
- Without TLS, credentials and cookies travel in clear text on the last hop. Prefer
  Tailscale/WireGuard (the WAN leg is encrypted) or enable TLS with `tlsCert`/`tlsKey`.
- Do **not** forward the port to the public internet.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer listed
in `package.json`. Please do not publish exploit details before a fix is available.
