<#
.SYNOPSIS
  Prepare and publish this plugin as a public GitHub repository (no npm needed).

.DESCRIPTION
  GitHub-only release flow:
    1. checks the identity placeholders are filled and runs the tests;
    2. initializes the repository (if needed), commits, and tags v<version>;
    3. regenerates dsh-plugin-index.json with a git source pinned to the code
       commit, commits it, and tags the final commit;
    4. optionally pushes `main` and the tag (requires your GitHub credentials).

  Pushing the tag triggers .github/workflows/release.yml, which runs the tests and
  attaches `dsh-lan-webui-<version>.tgz` to the GitHub Release — that tarball is
  the no-Git install path for other machines.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/release-github.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/release-github.ps1 -Push
#>
[CmdletBinding()]
param(
  [switch]$Push,
  [switch]$DryRun,
  [switch]$SkipTests,
  [string]$Remote = 'origin'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.name -cmatch 'OWNER' -or $pkg.repository.url -cmatch 'OWNER') {
  throw 'Identity placeholders are still present. Run scripts/set-identity.ps1 first.'
}
$tag = "v$($pkg.version)"
$repoUrl = $pkg.repository.url -replace '^git\+', '' -replace '\.git$', ''
Write-Host "Package: $($pkg.name)@$($pkg.version)"
Write-Host "Repo:    $repoUrl"

if (-not $SkipTests) {
  node test/smoke_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'smoke_test failed' }
  node test/official_sim.mjs
  if ($LASTEXITCODE -ne 0) { throw 'official_sim failed' }
  Write-Host 'Tests:   OK'
}

if (-not (Test-Path .git)) {
  if ($DryRun) { Write-Host 'Dry run: would run git init and commit.' } else { git init | Out-Null }
}
if (-not $DryRun) {
  git add -A
  if ((git status --porcelain) -ne '') {
    git commit -m "release $tag" | Out-Null
    Write-Host "Committed $tag"
  } else {
    Write-Host 'No changes to commit.'
  }
  $head = (git rev-parse HEAD).Trim()
  node scripts/gen-index.mjs --git --commit $head
  if ($LASTEXITCODE -ne 0) { throw 'market index generation failed' }
  git add dsh-plugin-index.json
  if ((git status --porcelain) -ne '') {
    git commit -m "index: pin $tag to $(git rev-parse --short HEAD)" | Out-Null
  }
  if ((git tag --list $tag) -eq '') {
    git tag -a $tag -m "release $tag" | Out-Null
    Write-Host "Tagged $tag"
  } else {
    Write-Host "Tag $tag already exists."
  }
}

if ($Push) {
  if ((git remote) -notcontains $Remote) {
    git remote add $Remote "$repoUrl.git"
  }
  git branch -M main
  git push -u $Remote main
  if ($LASTEXITCODE -ne 0) { throw 'git push failed (GitHub credentials?)' }
  git push $Remote $tag
  if ($LASTEXITCODE -ne 0) { throw 'git push --tags failed' }
  Write-Host ''
  Write-Host "Pushed. The release workflow now attaches the tarball to $tag." -ForegroundColor Green
  Write-Host "Discover index URL: https://raw.githubusercontent.com/$($repoUrl -replace '^https://github.com/','')/main/dsh-plugin-index.json"
  return
}

if ($DryRun) {
  Write-Host 'Dry run complete. Re-run with -Push (after creating the GitHub repo) to publish.' -ForegroundColor Yellow
} else {
  Write-Host ''
  Write-Host 'Repository prepared locally. Next:'
  Write-Host "  git remote add origin $repoUrl.git   # once"
  Write-Host '  powershell -ExecutionPolicy Bypass -File scripts/release-github.ps1 -Push'
}
