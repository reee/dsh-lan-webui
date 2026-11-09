<#
.SYNOPSIS
  Fill this release tree with your package name, GitHub owner, version and author.

.DESCRIPTION
  Rewrites the identity placeholders (`dsh-lan-webui`, `OWNER`, author, version) in
  package.json, cordis.patch.yml, README.md, docs and scripts, then regenerates
  dsh-plugin-index.json through the official validator.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/set-identity.ps1 `
    -Name dsh-lan-webui -GithubOwner yourname -Version 1.1.1 -Author "Your Name"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Name,
  [Parameter(Mandatory)][string]$GithubOwner,
  [string]$Version = '1.1.1',
  [string]$Author = 'dsh-lan-webui contributors',
  [string]$RepoName,
  [string]$CommitName,
  [string]$CommitEmail
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$current = (Get-Content package.json -Raw | ConvertFrom-Json).name
if (-not $RepoName) { $RepoName = ($Name -replace '^@[^/]+/', '') }

# 1. textual identity placeholders
$files = @('package.json', 'cordis.patch.yml', 'README.md', 'docs/design.md', 'scripts/gen-index.mjs', 'SECURITY.md')
foreach ($file in $files) {
  $path = Join-Path $root $file
  if (-not (Test-Path $path)) { continue }
  $text = Get-Content $path -Raw
  $text = $text.Replace($current, $Name)
  $text = $text.Replace('dsh-lan-webui', $Name)
  $text = $text.Replace('OWNER', $GithubOwner)
  Set-Content -Path $path -Value $text -Encoding utf8 -NoNewline
}

# 2. structured fields in package.json
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.name = $Name
$pkg.version = $Version
$pkg.author = $Author
$pkg.repository = [ordered]@{ type = 'git'; url = "git+https://github.com/$GithubOwner/$RepoName.git" }
$pkg.homepage = "https://github.com/$GithubOwner/$RepoName#readme"
$pkg.bugs = [ordered]@{ url = "https://github.com/$GithubOwner/$RepoName/issues" }
($pkg | ConvertTo-Json -Depth 10) | Set-Content package.json -Encoding utf8

# 3. repository-local commit identity (keeps a personal global email out of the
# public history; use the GitHub noreply address if you do not want your email
# published, e.g. 1234567+username@users.noreply.github.com)
if ($CommitName) { git config --local user.name $CommitName }
if ($CommitEmail) { git config --local user.email $CommitEmail }

# 4. regenerate and validate the market index
if (Test-Path node_modules) {
  node scripts/gen-index.mjs
} else {
  Write-Warning 'node_modules missing: run `npm install` (or set DSH_MARKET_VALIDATOR) then `npm run index:gen` to regenerate dsh-plugin-index.json.'
}

Write-Host ''
Write-Host "Identity set: $Name@$Version  ($GithubOwner/$RepoName)" -ForegroundColor Green
Write-Host 'Next: npm test, then scripts/release-github.ps1 (GitHub-only) or scripts/publish.ps1 (npm).'
