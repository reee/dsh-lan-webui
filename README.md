# dsh-lan-webui

把 **DeepSeek Harness 桌面版的 Web UI** 通过局域网/私网地址提供访问，并自带一套独立的
登录认证与设置页。官方服务器始终只听 `127.0.0.1`，本插件在选定的一张网卡地址上另起
监听器做反向代理 —— **不绑定 `0.0.0.0`**。

> Serve the DSH desktop Web UI on one chosen LAN address behind a password gate,
> with an in-app settings page. The official server keeps listening on loopback only.

- 零运行时依赖（仅 Node 内置模块 + 直连官方 Host）
- 密码（scrypt）+ IP 白名单 + 按 IP 限流锁定
- 应用内「设置 → 局域网访问」页面：改绑定地址、端口、密码、白名单
- 兼容 Tailscale 子网路由（白名单默认含 `100.64.0.0/10`）

## 为什么不是 `0.0.0.0`

官方 Web 服务器刻意拒绝绑定通配地址（防全网暴露）。本插件遵循同一原则：只绑定你指定的
那一张网卡 IPv4，并用独立密码层保护入口，而不是把无认证的 UI 暴露给整个网络。

## 环境要求

- DeepSeek Harness 桌面版（在 `0.2.2-rc.1` 上测试通过）
- Windows 10/11；Linux/macOS 未测试
- 目标机器无需安装 Node.js（使用桌面版自带的 Node 运行时）

## 安装

## 安装（从 GitHub）

本插件不依赖 npm registry，仓库本身就是可安装的 DSH 组合包（源码在仓库根目录）。

### 方式 A：应用内 Plugins 页（推荐）

**Plugins → 安装**，任选一种输入：

| 输入 | 说明 |
|---|---|
| `github:<owner>/<repo>#v1.1.1` | 安装指定 tag（推荐，可复现）；目标机器需有 Git |
| `github:<owner>/<repo>` | 安装默认分支最新提交 |
| `https://github.com/<owner>/<repo>` | 同上（也接受 `.git` 后缀与 `#tag`） |
| `https://github.com/<owner>/<repo>/releases/download/v1.1.1/dsh-lan-webui-1.1.1.tgz` | GitHub Release 附件；**不需要 Git** |
| 本地 `...\dsh-lan-webui-1.1.1.tgz` 绝对路径 | 离线分发；不需要 Git |

> 目标机器没有 Git 时，用 Release 的 `.tgz` 附件（或本地路径）安装即可；两种方式装出的是
> 同一个包内容。

### 方式 B：一条命令（离线/脚本化）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会拷贝插件到 profile、追加加载条目（幂等）、写入 `%USERPROFILE%\.dsh\lan-access.json`，
可用 `-LanHost`、`-Port`、`-Profile`、`-Password`、`-Firewall`、`-Uninstall`。

### 方式 C：手动

1. 把 `index.js`、`client.js`、`package.json`、`cordis.patch.yml` 拷到
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-lan-webui\`
2. 在 profile 的 `cordis.patch.yml` 末尾追加（必须用 `insert:`）：

   ```yaml
   - insert:
       - id: lan-access
         name: dsh-lan-webui
   ```

3. 写入本机配置（二选一）：
   - 跑 `setup.js`（见下）；或
   - 界面里配置（未配置时设置页仍可用）
4. 重启桌面应用。

### 安装后

打开 **设置 → 局域网访问**，填写密码、确认绑定地址 → 保存 → 重启应用。
浏览器访问 `http://<内网IP>:3443` 登录。

> 从 Git 安装便于跟随 `main` 最新提交；从 tag/Release 安装更利于复现。升级时在 Plugins 页
> 重新安装新 tag 即可，本机配置（`lan-access.json`、会话密钥）不受影响。

## 首次配置（无界面时）

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-lan-webui\setup.js" --stdin
```

参数：`--host <ip|auto>`（默认自动探测内网 IPv4）、`--port 3443`、`--cidrs a,b`
（默认 `<host>/24` + `100.64.0.0/10`）、`--home <dir>`、`--print`、`--print-hash`。

## 使用

- `http://<内网IP>:3443` → 登录页 → 密码 → 与桌面端一致的 UI（同一套会话/工作区）。
- 首次进入经一次官方 launch token → Cookie 交换（浏览器自动跟随 303），token 不出现在
  地址栏；桌面重启后端口变化能自动恢复。
- 辅助端点：`/__lan/status`（登录后 JSON）、`/__lan/logout`（清会话）。

## 设置页

**设置 → 局域网访问**：

| 项目 | 生效方式 |
|---|---|
| 访问密码 | 立即生效；修改会吊销所有已登录的局域网设备 |
| IP 白名单 | 立即生效；留空表示不限制来源（请谨慎） |
| 绑定地址 / 端口 | 写入配置，**重启应用后生效** |
| 状态 / 配置文件路径 | 只读展示 |

如果 `cordis.patch.yml` 里写了该条目的 `config`，它会覆盖设置页，此时页面显示只读并禁止保存。

## 配置项（`$DSH_HOME/lan-access.json` 或 patch `config`）

```json
{
  "lanHost": "192.168.1.20",
  "port": 3443,
  "passwordScrypt": "scrypt$16384$8$1$<salt>$<hash>",
  "allowCidrs": ["192.168.1.0/24", "100.64.0.0/10"],
  "cookieMaxAgeDays": 7,
  "tlsCert": "C:\\certs\\lan.pem",
  "tlsKey": "C:\\certs\\lan-key.pem"
}
```

配置优先级：patch `config` > `lan-access.json` > 内置默认。

## 安全

**登录成功 = 对该 DSH 实例的完全控制（可执行命令）。** 密码、白名单、限流是唯一防线。
不要把端口映射到公网；跨不可信网络请使用 Tailscale/WireGuard，或配置 TLS。
详见 [SECURITY.md](SECURITY.md)。

## Tailscale

设备 → WireGuard（tailnet）→ 子网路由器 → 内网 → 本机 3443。
- WAN 段已由 WireGuard 加密；
- 白名单默认含 `100.64.0.0/10`（tailnet CGNAT 段，子网路由器保留源 IP 时使用）；
- 若子网路由器做了 SNAT，源 IP 会变成路由器内网地址，已由 `<host>/24` 覆盖；
- 建议在 tailnet ACL 中把可达范围限制到 `本机:3443`。

## 卸载

- Plugins 页删除该组合包；或 `install.ps1 -Uninstall`；或删除 patch 条目与包目录。
- 重启应用后 LAN 入口消失；删除 `$DSH_HOME/.lan-access-secret` 可吊销全部 LAN 会话。

## 开发与测试

```bash
npm test                      # = node test/smoke_test.mjs && node test/official_sim.mjs
```

两个测试都是纯 Node、无需安装桌面版。架构与威胁模型见 [docs/design.md](docs/design.md)。

## 发布（维护者）

本仓库可直接作为 GitHub 发布源，**不依赖 npm**：仓库根目录即组合包，打 tag 时
GitHub Actions 会跑测试并把 `.tgz` 附件挂到 Release（免 Git 的安装路径）。

```powershell
npm install                                   # 只为校验器（devDependency）
powershell -ExecutionPolicy Bypass -File scripts/set-identity.ps1 `
  -Name <包名> -GithubOwner <你的GitHub用户名> -Version 1.1.1 `
  -Author "<署名>" -CommitEmail "<提交邮箱>"
powershell -ExecutionPolicy Bypass -File scripts/release-github.ps1 -DryRun   # 预检 + 演练
powershell -ExecutionPolicy Bypass -File scripts/release-github.ps1 -Push     # 提交 + tag + 推送
```

`release-github.ps1` 会用 `gen-index --git` 把 `dsh-plugin-index.json` 钉在当前提交上；
用户把该文件的 raw URL 添加到 **插件 → 发现** 即可浏览安装。GitHub 与 npm 可并存
（`scripts/publish.ps1` 走 npm 路线）。

每次发版先提升版本号；tag 名使用 `v<version>`。

## 兼容性说明

本插件依赖桌面版的公开接缝：Cordis 服务的 `webServer` / `connection`、bundle patch
格式、以及客户端插件格式（`dsh.client` + `window.__ModuleLoader__`）。DSH 仍处于
开发者预览阶段，若版本升级后入口失效，请提交 issue 并附 `dsh` 版本。

## License

MIT
