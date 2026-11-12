$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-ReleaseHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required' }
$releaseName = 'BOSS-Finance-Assistant-v' + $manifest.version
$dist = Join-Path $projectRoot 'dist'
$stage = Join-Path $dist ($releaseName + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'manifest.json'),(Join-Path $projectRoot 'README.md') -Destination $stage
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination $stage -Recurse

foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $stage 'src') -File -Recurse -Filter '*.js')) {
  & node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failure: $($file.Name)" }
}
$references = @($manifest.action.default_popup, $manifest.side_panel.default_path, $manifest.background.service_worker)
foreach ($content in $manifest.content_scripts) { $references += $content.js }
foreach ($reference in $references) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $reference))) { throw "Missing manifest file: $reference" }
}

$archive = Join-Path $dist ($releaseName + '.zip')
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $files = @(Get-ChildItem -LiteralPath $stage -File -Recurse)
  $entries = @($zip.Entries | Where-Object { $_.Name })
  if ($entries.Count -ne $files.Count) { throw 'Package file count mismatch' }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $entries | Where-Object { $_.FullName.Replace('\', '/') -eq $relative }
    if (-not $entry) { throw "Missing archive entry: $relative" }
    $stream = $entry.Open()
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      $packedHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
      if ($packedHash -ne (Get-ReleaseHash $file.FullName)) { throw "Archive hash mismatch: $relative" }
    } finally { $stream.Dispose() }
  }
} finally { $zip.Dispose() }
[pscustomobject]@{
  Version = $manifest.version
  UnpackedFolder = $stage
  Archive = $archive
  Files = $files.Count
  SHA256 = Get-ReleaseHash $archive
} | ConvertTo-Json
