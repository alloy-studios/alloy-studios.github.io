<#
  Shared helpers for build.ps1 and import.ps1.

  Windows PowerShell writes UTF-8 *with* a BOM and pretty-prints JSON with
  odd alignment. data/games.json is meant to be edited by hand, so both of
  those matter - hence these two helpers.
#>

function Write-Utf8 {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function ConvertTo-PrettyJson {
  param($Value, [int]$Indent = 0)

  $pad  = ' ' * $Indent
  $pad2 = ' ' * ($Indent + 2)

  if ($null -eq $Value) { return 'null' }

  if ($Value -is [bool])   { return $(if ($Value) { 'true' } else { 'false' }) }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Value -is [string]) {
    $s = $Value -replace '\\', '\\' -replace '"', '\"' -replace "`r", '\r' -replace "`n", '\n' -replace "`t", '\t'
    return '"' + $s + '"'
  }

  if ($Value -is [System.Collections.IEnumerable]) {
    $items = @($Value)
    if ($items.Count -eq 0) { return '[]' }
    $parts = $items | ForEach-Object { $pad2 + (ConvertTo-PrettyJson $_ ($Indent + 2)) }
    return "[`n" + ($parts -join ",`n") + "`n$pad]"
  }

  $props = @($Value.PSObject.Properties)
  if ($props.Count -eq 0) { return '{}' }
  $parts = $props | ForEach-Object {
    $pad2 + (ConvertTo-PrettyJson $_.Name ($Indent + 2)) + ': ' + (ConvertTo-PrettyJson $_.Value ($Indent + 2))
  }
  return "{`n" + ($parts -join ",`n") + "`n$pad}"
}
