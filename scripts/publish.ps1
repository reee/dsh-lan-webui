<#
.SYNOPSIS
  Preflight and publish this plugin to npm, then print the release follow-ups.

.DESCRIPTION
  Checks the package identity, syntax of both halves, runs the tests, validates the
  market index, packs, then publishes the current version (never re-publishes an
  existing version: npm rejects that).

  Requires an authenticated npm CLI (`npm login`) with permission for the package
  name. Publishing is permanent: a version can be deprecated but not deleted, so
  bump the version for every release.

  Use -DryRun to stop after `npm publish --dry-run`.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/publish.ps1
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1. identity sanity
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.name -cmatch 'OWNER' -or $pkg.repository.url -cmatch 'OWNER') {
  throw 'Identity placeholders are still present. Run scripts/set-identity.ps1 first.'
}
if ($pkg.private -eq $true) { throw 'package.json is private; publishing requires removing "private".' }
Write-Host "Package:    $($pkg.name)@$($pkg.version)"
Write-Host "Repository: $($pkg.repository.url)"

# 2. syntax + tests
node --check index.js
node --check client.js
Write-Host 'Syntax:     OK'
if (-not $SkipTests) {
  node test/smoke_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'smoke_test failed' }
  node test/official_sim.mjs
  if ($LASTEXITCODE -ne 0) { throw 'official_sim failed' }
  Write-Host 'Tests:      OK'
}

# 3. market index regenerated and validated (validator is a devDependency)
if (Test-Path node_modules) {
  node scripts/gen-index.mjs
  if ($LASTEXITCODE -ne 0) { throw 'market index validation failed' }
} else {
  Write-Warning 'node_modules missing: skipping dsh-plugin-index.json regeneration (npm install to enable).'
}

# 4. npm auth
npm whoami
if ($LASTEXITCODE -ne 0) { throw 'Not logged in to npm. Run `npm login` first.' }

# 5. pack + publish
npm pack
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
if ($DryRun) {
  npm publish --dry-run
  Write-Host ''
  Write-Host 'Dry run complete. Re-run without -DryRun to publish.' -ForegroundColor Yellow
  return
}
npm publish --access public
if ($LASTEXITCODE -ne 0) { throw 'npm publish failed' }
Write-Host ''
Write-Host "Published $($pkg.name)@$($pkg.version)." -ForegroundColor Green
Write-Host 'Follow-ups:'
Write-Host '  1. git add . && git commit -m "release v$($pkg.version)" && git tag v$($pkg.version) && git push --tags'
Write-Host '  2. commit the regenerated dsh-plugin-index.json so it is served from the repo root'
Write-Host '  3. add the index URL in Plugins → Discover to verify the listing'
