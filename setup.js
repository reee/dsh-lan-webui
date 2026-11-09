// Machine setup for dsh-lan-access: writes $DSH_HOME/lan-access.json with the
// password hash and bind address, so the bundle needs no YAML editing.
//
// Run with the desktop app's bundled Node (no system Node required):
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals setup.js "<password>"
//
// Options:
//   --host <ip|auto>   bind address (default: auto-detect a private IPv4)
//   --port <n>         listen port (default 3443)
//   --cidrs a,b        IP allowlist (default: <host>/24,100.64.0.0/10)
//   --home <dir>       DSH home (default: $DSH_HOME or ~/.dsh)
//   --print            print the JSON instead of writing it
//   --print-hash       print only the scrypt hash line (legacy patch style)
//   --stdin            read the password from stdin (keeps it out of argv)
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

function usage(message) {
  if (message) console.error(`setup: ${message}`);
  console.error('usage: setup.js "<password>" [--host <ip|auto>] [--port <n>] [--cidrs a,b] [--home <dir>] [--print] [--print-hash] [--stdin]');
  process.exit(1);
}

const argv = process.argv.slice(2);
let password;
const options = { host: 'auto', port: 3443, cidrs: undefined, home: undefined, print: false, printHash: false, stdin: false };

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--host') options.host = argv[++i] ?? usage('--host needs a value');
  else if (arg === '--port') options.port = Number(argv[++i] ?? usage('--port needs a value'));
  else if (arg === '--cidrs') options.cidrs = (argv[++i] ?? usage('--cidrs needs a value')).split(',').map((s) => s.trim()).filter(Boolean);
  else if (arg === '--home') options.home = argv[++i] ?? usage('--home needs a value');
  else if (arg === '--print') options.print = true;
  else if (arg === '--print-hash') options.printHash = true;
  else if (arg === '--stdin') options.stdin = true;
  else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
  else if (password === undefined) password = arg;
  else usage('unexpected extra argument');
}

if (options.stdin) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
if (password === undefined || password === '') usage('a password is required (argument or --stdin)');
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) usage('--port must be 1..65535');

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
const lanHost = options.host === 'auto' ? detectLanHost() : options.host;
if (!lanHost) {
  console.error('setup: could not detect a LAN IPv4 address; pass --host <ip>');
  process.exit(1);
}
const allowCidrs = options.cidrs ?? [`${lanHost.split('.').slice(0, 3).join('.')}.0/24`, '100.64.0.0/10'];
const salt = randomBytes(16);
const hash = scryptSync(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
const passwordScrypt = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;

if (options.printHash) {
  console.log(passwordScrypt);
  process.exit(0);
}

const config = { lanHost, port: options.port, passwordScrypt, allowCidrs, cookieMaxAgeDays: 7 };
const json = JSON.stringify(config, null, 2);
if (options.print) {
  console.log(json);
  process.exit(0);
}

const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const file = join(home, 'lan-access.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${json}\n`, 'utf8');
console.log(`wrote ${file}`);
console.log(`  lanHost: ${lanHost}`);
console.log(`  port:    ${options.port}`);
console.log(`  allow:   ${allowCidrs.join(', ')}`);
console.log('Restart the desktop app to apply. Open http://' + lanHost + ':' + options.port + ' and sign in with the password you just entered.');
