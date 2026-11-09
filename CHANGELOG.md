# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-11-09

### Fixed
- `install.ps1` did not copy `client.js`, so scripted installs had no settings page.
- A config pinned in the profile patch made the settings page look writable while
  the patch silently overrode every save; the page is now read-only in that case
  and the Host rejects writes with a clear error.
- Changing the password while a bind-address change was pending did not take effect
  until restart.
- Rotating the session secret now invalidates sessions even if persisting the new
  secret fails.

## [1.1.0] - 2026-11-09

### Added
- In-app settings page (**Settings → 局域网访问**): bind address, port, password,
  IP allowlist, live status, and a read-only warning when the profile patch pins the
  configuration.
- Same-origin Host route `GET/POST /lan-access/config`, admitted only for the owner
  browser and never returning the password hash.
- Machine-local configuration moved to `$DSH_HOME/lan-access.json` so the package
  itself carries no credentials.
- Package is now a DSH bundle (`dsh.bundle.patch`) with a client half (`dsh.client`),
  installable from the Plugins page.

## [1.0.0] - 2026-11-09

### Added
- LAN listener bound to one chosen interface with password login (scrypt), signed
  session cookie, per-IP rate limiting and lockout, IPv4 CIDR allowlist.
- Reverse proxy to the loopback official server with Host/Origin rewriting, launch
  token injection only on the loopback hop, WebSocket piping, and stale-cookie
  recovery after restarts.
- `setup.js` for machine configuration and `install.ps1` for scripted installs.
