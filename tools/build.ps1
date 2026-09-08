<#
  Regenerates the per-game wrapper pages, the sitemap and robots.txt
  from data/games.json.

      powershell -ExecutionPolicy Bypass -File tools\build.ps1
      powershell -ExecutionPolicy Bypass -File tools\build.ps1 -Prune

  Every wrapper page is a byte-for-byte copy of tools\wrapper.html, so
  editing that one file and re-running this restyles every game at once.
  -Prune also deletes wrapper folders for games no longer in games.json.
#>

param([switch]$Prune)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib.ps1')

$data    = Get-Content (Join-Path $Root 'data\games.json') -Raw -Encoding utf8 | ConvertFrom-Json
$wrapper = Get-Content (Join-Path $Root 'tools\wrapper.html') -Raw -Encoding utf8
$origin  = if ($data.site.origin) { $data.site.origin } else { 'https://alloy-studios.github.io' }

$ids = New-Object System.Collections.Generic.HashSet[string]
$warnings = 0

foreach ($game in @($data.games)) {
  if ($game.id -notmatch '^[a-z0-9][a-z0-9-]*$') {
    Write-Host "  ! '$($game.id)' is not a safe URL id (lowercase letters, digits, hyphens)" -ForegroundColor Red
    $warnings++
    continue
  }
  [void]$ids.Add($game.id)

  if (-not (Test-Path (Join-Path $Root "games\$($game.id)\index.html"))) {
    Write-Host "  ! games\$($game.id)\index.html is missing - /$($game.id)/ will load a blank frame" -ForegroundColor Yellow
    $warnings++
  }

  $dir = Join-Path $Root $game.id
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  Write-Utf8 (Join-Path $dir 'index.html') $wrapper
  Write-Host "  + /$($game.id)/"
}

# A staging route that no repo can shadow. While an old project page is still
# switched on it owns /<id>/, so the real wrapper there is invisible - but
# /preview/?g=<id> is served by this repo and renders the same shell, which is
# how you confirm a game works before retiring its old Pages site.
$previewDir = Join-Path $Root 'preview'
if (-not (Test-Path $previewDir)) { New-Item -ItemType Directory -Path $previewDir | Out-Null }
Write-Utf8 (Join-Path $previewDir 'index.html') $wrapper

# Wrapper folders left behind by games that are no longer in the manifest.
$reserved = @('assets', 'data', 'games', 'tools', 'preview')
$stale = Get-ChildItem -Path $Root -Directory |
  Where-Object { $reserved -notcontains $_.Name -and $_.Name -notlike '.*' } |
  Where-Object { -not $ids.Contains($_.Name) } |
  Where-Object { Test-Path (Join-Path $_.FullName 'index.html') }

foreach ($dir in $stale) {
  if ($Prune) {
    Remove-Item $dir.FullName -Recurse -Force
    Write-Host "  - removed stale wrapper /$($dir.Name)/" -ForegroundColor DarkGray
  } else {
    Write-Host "  ? /$($dir.Name)/ is not in games.json (re-run with -Prune to delete)" -ForegroundColor DarkGray
  }
}

# Sitemap + robots, so the games are findable.
$urls = @("  <url><loc>$origin/</loc></url>")
foreach ($game in @($data.games)) { $urls += "  <url><loc>$origin/$($game.id)/</loc></url>" }
$sitemap = @"
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
$($urls -join "`n")
</urlset>
"@
Write-Utf8 (Join-Path $Root 'sitemap.xml') $sitemap
Write-Utf8 (Join-Path $Root 'robots.txt') "User-agent: *`nAllow: /`nDisallow: /preview/`nSitemap: $origin/sitemap.xml`n"

$msg = "`nBuilt $(@($data.games).Count) game page(s)"
if ($warnings) { $msg += ", $warnings warning(s)" }
Write-Host $msg -ForegroundColor Green
