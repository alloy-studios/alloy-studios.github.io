<#
  Tiny static web server for previewing the site locally.

      powershell -ExecutionPolicy Bypass -File tools\serve.ps1
      then open http://localhost:8080/

  You need this rather than double-clicking index.html: the pages fetch
  data/games.json and use root-absolute paths, and browsers block both
  over file://. Ctrl+C to stop.
#>

param([int]$Port = 8080)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml';  '.png' = 'image/png';  '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg';     '.gif' = 'image/gif';  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon';   '.wasm' = 'application/wasm'
  '.mp3'  = 'audio/mpeg';     '.ogg' = 'audio/ogg';  '.wav' = 'audio/wav'
  '.mp4'  = 'video/mp4';      '.webm' = 'video/webm'
  '.woff' = 'font/woff';      '.woff2' = 'font/woff2'; '.ttf' = 'font/ttf'
  '.txt'  = 'text/plain; charset=utf-8'; '.xml' = 'application/xml; charset=utf-8'
  '.pck'  = 'application/octet-stream'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() }
catch { throw "Could not listen on port $Port. Try -Port 8081, or close whatever is using it." }

Write-Host "Alloy Studios preview -> http://localhost:$Port/" -ForegroundColor Green
Write-Host "Serving $Root  (Ctrl+C to stop)" -ForegroundColor DarkGray

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $urlPath = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    $rel = $urlPath.TrimStart('/') -replace '/', '\'
    $full = if ($rel) { Join-Path $Root $rel } else { $Root }

    if (Test-Path $full -PathType Container) { $full = Join-Path $full 'index.html' }

    $status = 200
    if (-not (Test-Path $full -PathType Leaf)) {
      $status = 404
      $full = Join-Path $Root '404.html'
    }

    try {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.StatusCode = $status
      $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $ctx.Response.Headers['Cache-Control'] = 'no-store'
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      $ctx.Response.StatusCode = 500
    }

    Write-Host ("{0,3}  {1}" -f $status, $urlPath) -ForegroundColor DarkGray
    $ctx.Response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
