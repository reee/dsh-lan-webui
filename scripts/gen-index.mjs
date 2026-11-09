// Generate dsh-plugin-index.json from package.json and validate it with the
// official format-1 validator.
//
// Usage:
//   node scripts/gen-index.mjs             # npm source (after npm publish)
//   node scripts/gen-index.mjs --git       # git source pinned to the HEAD commit
//   node scripts/gen-index.mjs --git --commit <40-hex>   # explicit commit (CI/tests)
//
// Validator sources, in order:
//   1. DSH_MARKET_VALIDATOR (a module specifier or file: URL), useful with a
//      local DeepSeek Harness install;
//   2. the devDependency `@deepseek-ai/dsh-plugin-market-index` (npm install).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const gitMode = argv.includes('--git');
const commitIndex = argv.indexOf('--commit');
const explicitCommit = commitIndex === -1 ? undefined : argv[commitIndex + 1];

const candidates = [process.env.DSH_MARKET_VALIDATOR, '@deepseek-ai/dsh-plugin-market-index'].filter(Boolean);
let parseMarketIndex;
for (const candidate of candidates) {
  try {
    ({ parseMarketIndex } = await import(candidate));
    break;
  } catch { /* try the next source */ }
}
if (parseMarketIndex === undefined) {
  console.error('Cannot load the market index validator.');
  console.error('Run `npm install`, or set DSH_MARKET_VALIDATOR to the validator module.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const repoUrl = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
const ownerRepo = repoUrl.replace(/^https:\/\/github\.com\//, '');
const indexUrl = `https://raw.githubusercontent.com/${ownerRepo}/main/dsh-plugin-index.json`;

let source = { type: 'npm' };
if (gitMode) {
  let commit = explicitCommit;
  if (commit === undefined) {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error(`git source needs a lowercase 40-hex commit, got ${JSON.stringify(commit)}`);
    process.exit(1);
  }
  source = { type: 'git', url: repoUrl, commit };
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d2025"/><circle cx="27" cy="30" r="13" fill="none" stroke="#4c8dff" stroke-width="3"/><path d="M14 30h26M27 17c6 7 6 19 0 26M27 17c-6 7-6 19 0 26" fill="none" stroke="#4c8dff" stroke-width="2"/><rect x="38" y="34" width="18" height="14" rx="3" fill="#3fb950"/><path d="M42 34v-4a5 5 0 0 1 10 0v4" fill="none" stroke="#3fb950" stroke-width="3"/></svg>`;
const icon = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const index = {
  format: 1,
  title: { en: 'DSH community plugins', zh: 'DSH 社区插件' },
  description: {
    en: 'Community bundles for DeepSeek Harness. Add this URL in Plugins → Discover.',
    zh: 'DeepSeek Harness 社区插件索引。在 插件 → 发现 中添加此 URL。',
  },
  metadata: {
    categories: { access: { title: { en: 'Access & networking', zh: '访问与网络' } } },
    labels: {
      security: { title: { en: 'Security', zh: '安全' } },
      windows: { title: { en: 'Windows', zh: 'Windows' } },
      tailscale: { title: { en: 'Tailscale', zh: 'Tailscale' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'LAN Web UI', zh: '局域网 Web UI' },
      description: {
        en: 'Serve the DSH desktop Web UI on one LAN address behind password + IP-allowlist authentication, with an in-app settings page. Never binds 0.0.0.0.',
        zh: '在选定的局域网地址上提供桌面 Web UI，自带密码 + IP 白名单认证与应用内设置页；绝不绑定 0.0.0.0。',
      },
      icon,
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: repoUrl },
      metadata: {
        category: 'access',
        keywords: ['lan', 'tailscale', 'authentication', 'settings', 'web-ui'],
        labels: ['security', 'windows', 'tailscale'],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source,
        },
      ],
    },
  ],
};

const parsed = parseMarketIndex(index, indexUrl);
writeFileSync('dsh-plugin-index.json', `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`VALID index for ${pkg.name}@${pkg.version} (${source.type} source)`);
console.log(`  Discover index URL: ${indexUrl}`);
