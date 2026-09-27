<#
  Builds alloy-firebase.zip for upload to Google Cloud Shell, where the
  Alloy account server is deployed from (this PC has no Node.js).

      powershell -ExecutionPolicy Bypass -File tools\pack-firebase.ps1

  Entry names use forward slashes. Windows' Compress-Archive writes
  backslashes, which Linux unzip turns into files literally named
  "functions\index.js" — the Speed Simulator deploy hit exactly that.
#>

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $Root 'firebase'
$out  = Join-Path $Root 'alloy-firebase.zip'

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path $out) { Remove-Item $out -Force }

$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
$n = 0
try {
  Get-ChildItem $src -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
    ForEach-Object {
      $rel = $_.FullName.Substring($src.Length + 1) -replace '\\', '/'
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "alloy-firebase/$rel")
      $n++
    }
} finally {
  $zip.Dispose()
}
Write-Host "Built $out ($n files). Upload it to Cloud Shell." -ForegroundColor Green
