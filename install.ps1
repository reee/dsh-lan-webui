<#
.SYNOPSIS
  Install dsh-lan-access into a DeepSeek Harness desktop profile and configure it.

.DESCRIPTION
  Offline/scripted install (alternative to the in-app Plugins page):
    1. copies the package into <DSH_HOME>\profiles\<Profile>\node_modules\dsh-lan-access
    2. adds the loader entry to the profile's cordis.patch.yml (idempotent)
    3. writes <DSH_HOME>\lan-access.json via setup.js (password hash + LAN address)
    4. optionally adds a Windows Firewall rule.

  Requires the DeepSeek Harness desktop app on this machine (its bundled Node runs
  setup.js; no system Node required). Restart the app afterwards.

.PARAMETER Password
  Login password for the LAN page. Omit to be prompted securely.

.PARAMETER LanHost
  Address to listen on, or 'auto' (default) to pick a private IPv4 address.

.PARAMETER Port
  Listen port. Default 3443.

.PARAMETER Profile
  Profile name. Default 'desktop'.

.PARAMETER AppExe
  Path to "DeepSeek Harness.exe" when it is not in a default location.

.PARAMETER Firewall
  Also add a port-scoped inbound firewall rule (needs an elevated PowerShell).

.PARAMETER Uninstall
  Remove the package and its loader entry instead of installing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -Password 'my secret' -LanHost 192.168.1.20 -Port 3443 -Firewall
#>
[CmdletBinding()]
param(
  [string]$Password,
  [string]$LanHost = 'auto',
  [int]$Port = 3443,
  [string]$Profile = 'desktop',
  [string]$AppExe,
  [switch]$Firewall,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$PkgName = 'dsh-lan-access'
$SourceDir = $PSScriptRoot

function Resolve-AppExe {
  if ($AppExe) {
    if (-not (Test-Path -LiteralPath $AppExe)) { throw "AppExe not found: $AppExe" }
    return (Resolve-Path -LiteralPath $AppExe).Path
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  throw 'Could not find "DeepSeek Harness.exe"; pass -AppExe <path>.'
}

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "Profile directory not found: $ProfileDir (is the app installed and named '$Profile'?)" }
$TargetDir = Join-Path (Join-Path $ProfileDir 'node_modules') $PkgName
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

if ($Uninstall) {
  if (Test-Path -LiteralPath $TargetDir) { Remove-Item -LiteralPath $TargetDir -Recurse -Force }
  if (Test-Path -LiteralPath $PatchPath) {
    $text = Get-Content -LiteralPath $PatchPath -Raw
    $pattern = '(?ms)^- insert:\s*\r?\n(?:\s+- id: lan-access\s*\r?\n\s+name: dsh-lan-access\s*\r?\n?)+'
    $new = [regex]::Replace($text, $pattern, '')
    if ($new -ne $text) { Set-Content -LiteralPath $PatchPath -Value $new -NoNewline -Encoding utf8; Write-Host "Removed loader entry from $PatchPath" }
  }
  $manifestPath = Join-Path $ProfileDir 'package.json'
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      if (@($manifest.dsh.profile.bundles) -contains $PkgName) {
        Write-Warning "The '$PkgName' bundle is still listed in $manifestPath; remove it from the in-app Plugins page too."
      }
    } catch { }
  }
  $configPath = Join-Path $DshHome 'lan-access.json'
  if (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
  Write-Host ''
  Write-Host 'Uninstalled. Restart the desktop app to stop the LAN listener.' -ForegroundColor Yellow
  return
}

if (-not $Password) {
  $secure = Read-Host -AsSecureString "Password for the LAN page"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $Password) { throw 'A password is required.' }

$app = Resolve-AppExe
Write-Host "App:        $app"
Write-Host "Profile:    $ProfileDir"

# 1. copy the package into the profile
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$files = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'setup.js', 'README.md')
foreach ($name in $files) {
  $source = Join-Path $SourceDir $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $TargetDir $name) -Force }
}
Write-Host "Copied:     $TargetDir"

# 2. add the loader entry (idempotent; skipped when the bundle already provides it)
$manifestPath = Join-Path $ProfileDir 'package.json'
$bundleProvided = $false
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $bundleProvided = @($manifest.dsh.profile.bundles) -contains $PkgName
  } catch { }
}
$entry = @'

- insert:
    - id: lan-access
      name: dsh-lan-access
'@
$patchText = if (Test-Path -LiteralPath $PatchPath) { Get-Content -LiteralPath $PatchPath -Raw } else { '' }
if ($bundleProvided) {
  Write-Host "Patched:    skipped (the '$PkgName' bundle already inserts the entry)"
} elseif ($patchText -notmatch '(?m)^\s+name:\s*dsh-lan-access\s*$') {
  Add-Content -LiteralPath $PatchPath -Value $entry -Encoding utf8
  Write-Host "Patched:    $PatchPath"
} else {
  Write-Host "Patched:    already present in $PatchPath"
}

# 3. write machine config through the app's bundled Node
$env:ELECTRON_RUN_AS_NODE = '1'
$setup = Join-Path $TargetDir 'setup.js'
$setupArgs = @('--expose-internals', $setup, '--stdin', '--host', $LanHost, '--port', "$Port", '--home', $DshHome)
$output = $Password | & $app @setupArgs *>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE -ne 0) { throw "setup.js failed:`n$($output -join "`n")" }
$output | ForEach-Object { Write-Host "  $_" }

# 4. optional firewall rule
if ($Firewall) {
  $subnet = if ($LanHost -eq 'auto') { $null } else { ($LanHost -split '\.')[0..2] -join '.' + '.0/24' }
  $remote = if ($subnet) { "$subnet,100.64.0.0/10" } else { '100.64.0.0/10,192.168.0.0/16' }
  $result = netsh advfirewall firewall add rule name="DSH LAN Web UI" dir=in action=allow protocol=TCP localport=$Port remoteip=$remote 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Write-Host "Firewall:   rule added for port $Port" }
  else { Write-Warning "Firewall rule needs an elevated PowerShell. Run:`n  netsh advfirewall firewall add rule name=\"DSH LAN Web UI\" dir=in action=allow protocol=TCP localport=$Port remoteip=$remote`n$result" }
}

Write-Host ''
Write-Host 'Done. Fully quit and reopen the desktop app, then open http://<this machine>:' -NoNewline
Write-Host $Port -NoNewline
Write-Host ' and sign in with the password.'
