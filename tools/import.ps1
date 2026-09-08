<#
  Pulls one of your existing game folders into the portal.

      powershell -ExecutionPolicy Bypass -File tools\import.ps1 `
        -Path "C:\Users\fatih\Desktop\snake-game" -Title "Snake" -Tags "arcade,classic"

  It copies the game into games\<id>\, registers it in data\games.json,
  and rebuilds so /<id>/ exists. Your original folder is never modified.
#>

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Id,
  [string]$Title,
  [string]$Tagline,
  [string]$Tags = 'game',
  [string]$Controls
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib.ps1')

if (-not (Test-Path $Path)) { throw "No such folder: $Path" }
$src = (Resolve-Path $Path).Path

function ConvertTo-Slug([string]$s) {
  ($s.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
}

if (-not $Id) { $Id = ConvertTo-Slug (Split-Path $src -Leaf) }
$Id = ConvertTo-Slug $Id
if (-not $Title) {
  $Title = ($Id -split '-' | ForEach-Object { $_.Substring(0,1).ToUpper() + $_.Substring(1) }) -join ' '
}

# Find the folder that actually holds the playable index.html.
$candidates = @('', 'docs', 'dist', 'build', 'public', 'site', 'game', 'www', 'src')
$gameRoot = $null
foreach ($sub in $candidates) {
  $dir = if ($sub) { Join-Path $src $sub } else { $src }
  if (Test-Path (Join-Path $dir 'index.html')) { $gameRoot = $dir; break }
}
if (-not $gameRoot) {
  throw "No index.html found in $src (looked in: $($candidates -ne '' -join ', ')). Copy it in by hand and add it to data\games.json."
}

# Copy, leaving repo plumbing behind.
$dest = Join-Path $Root "games\$Id"
robocopy $gameRoot $dest /E /XD .git .github .claude .vscode node_modules /XF .DS_Store README.md LICENSE .gitignore /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
$global:LASTEXITCODE = 0
Write-Host "Copied $gameRoot"
Write-Host "     -> games\$Id\"

# Register it in the manifest.
$dataPath = Join-Path $Root 'data\games.json'
$data = Get-Content $dataPath -Raw -Encoding utf8 | ConvertFrom-Json

if (@($data.games).id -contains $Id) {
  Write-Host "games.json already has '$Id' - left its metadata alone." -ForegroundColor DarkGray
} else {
  $entry = [ordered]@{
    id          = $Id
    title       = $Title
    tagline     = if ($Tagline) { $Tagline } else { '' }
    description = if ($Tagline) { $Tagline } else { "Play $Title free in your browser." }
    tags        = @($Tags -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    controls    = if ($Controls) { $Controls } else { '' }
    added       = (Get-Date -Format 'yyyy-MM-dd')
  }
  $data.games = @($data.games) + [pscustomobject]$entry
  Write-Utf8 $dataPath ((ConvertTo-PrettyJson $data) + "`n")
  Write-Host "Added '$Title' to data\games.json" -ForegroundColor Green
}

# Root-absolute paths worked when the game owned a whole site; they break now
# that it lives under /games/<id>/. Point them out rather than rewriting blind.
$flagged = Get-ChildItem $dest -Recurse -Include *.html, *.js, *.css -File |
  Where-Object { Select-String -Path $_.FullName -Pattern '(?:src|href)\s*=\s*["'']/|url\(\s*/' -Quiet }

if ($flagged) {
  Write-Host "`nHeads up - these files use root-absolute paths like src=""/thing.png""." -ForegroundColor Yellow
  Write-Host "The game now lives under /games/$Id/, so make them relative (""thing.png""):"
  $flagged | Select-Object -First 20 | ForEach-Object {
    Write-Host ('  ' + $_.FullName.Substring($dest.Length + 1))
  }
  if (@($flagged).Count -gt 20) { Write-Host "  ...and $(@($flagged).Count - 20) more" }
}

& (Join-Path $PSScriptRoot 'build.ps1')
Write-Host "`nDone. Play it at /$Id/" -ForegroundColor Green
