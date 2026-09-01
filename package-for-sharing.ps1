# ---------------------------------------------------------------------------
#  Package the app for someone else, WITH working API keys.
#
#  Run this from the project folder:
#      powershell -ExecutionPolicy Bypass -File package-for-sharing.ps1
#
#  It copies your .env into the package and applies three corrections that
#  matter when the app runs on a machine that is not yours:
#
#    EMAIL_ADAPTER                  -> mock   (so their copy cannot send email)
#    GOOGLE_APPLICATION_CREDENTIALS -> empty  (the key file is not on their disk,
#                                              and it grants write access to YOUR
#                                              live Google Sheet)
#    CREDENTIAL_SECRET              -> a fresh random value (yours unlocks a
#                                              mailbox token that is not in the
#                                              package, so sharing it gives away
#                                              a live secret for no benefit)
#
#  The Anthropic and Serper keys are copied as-is. Those are the two the
#  Generator actually needs, and they spend against YOUR accounts.
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$src   = $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stage = Join-Path $env:TEMP "ai-lead-share-$stamp\ai-lead-generator-agent"
$out   = Join-Path $HOME "Desktop"
if (-not (Test-Path $out)) { $out = Join-Path $HOME "Documents" }
if (-not (Test-Path $out)) { $out = $env:TEMP }
$zip   = Join-Path $out "ai-lead-generator-agent-ready.zip"

if (-not (Test-Path (Join-Path $src ".env"))) {
  Write-Host "No .env found in $src - nothing to package." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  Packaging AI Lead Generator Agent" -ForegroundColor Cyan
Write-Host "  ---------------------------------"
Write-Host ""

New-Item -ItemType Directory -Force $stage | Out-Null

# Everything except dependencies, build output, the local database and git.
$exclude = @("node_modules", ".next", ".pgdata", ".git", ".env",
             "export-data.json", "pair-database.xlsx", "package-for-sharing.ps1")

Get-ChildItem -Path $src -Force |
  Where-Object { $exclude -notcontains $_.Name } |
  ForEach-Object { Copy-Item -Path $_.FullName -Destination $stage -Recurse -Force }

Write-Host "  Copied source, scripts, prisma and docs"

# ---- the .env, with the three corrections ---------------------------------
$env_lines = Get-Content (Join-Path $src ".env")
$fresh = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) `
         -replace '\+','-' -replace '/','_' -replace '=',''

$fixed = $env_lines | ForEach-Object {
  if     ($_ -match '^EMAIL_ADAPTER=')                  { 'EMAIL_ADAPTER="mock"' }
  elseif ($_ -match '^GOOGLE_APPLICATION_CREDENTIALS=') { 'GOOGLE_APPLICATION_CREDENTIALS=""' }
  elseif ($_ -match '^CREDENTIAL_SECRET=')              { "CREDENTIAL_SECRET=`"$fresh`"" }
  else                                                   { $_ }
}

$header = @(
  '# ---------------------------------------------------------------------------',
  '# The Anthropic and Serper keys below are LIVE and belong to Jason. They spend',
  '# against his accounts, so get your own before doing anything at volume:',
  '#   Anthropic  https://console.anthropic.com',
  '#   Serper     https://serper.dev  (2,500 free credits, no card)',
  '#',
  '# EMAIL_ADAPTER is set to "mock" - this copy records messages and sends none.',
  '# ---------------------------------------------------------------------------',
  ''
)

Set-Content -Path (Join-Path $stage ".env") -Value ($header + $fixed) -Encoding utf8
Write-Host "  Wrote .env  (email adapter forced to mock, sheet credentials cleared)"

# ---- zip -------------------------------------------------------------------
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force

# ---- report ----------------------------------------------------------------
$check = Get-Content (Join-Path $stage ".env")
$has = { param($k) [bool]($check | Where-Object { $_ -match "^$k=`"?.+" -and $_ -notmatch "^$k=`"`"$" }) }

Write-Host ""
Write-Host "  Package ready" -ForegroundColor Green
Write-Host "    $zip"
Write-Host "    $([math]::Round((Get-Item $zip).Length / 1MB, 2)) MB"
Write-Host ""
Write-Host "  What is in the .env:"
Write-Host ("    ANTHROPIC_API_KEY   " + $(if (& $has "ANTHROPIC_API_KEY") { "present  (live, your account)" } else { "EMPTY - discovery will not work" }))
Write-Host ("    SERPER_API_KEY      " + $(if (& $has "SERPER_API_KEY") { "present  (live, your account)" } else { "EMPTY - discovery will not work" }))
Write-Host ("    GOOGLE_CLIENT_ID    " + $(if (& $has "GOOGLE_CLIENT_ID") { "present  (they connect their own Gmail)" } else { "empty" }))
Write-Host "    EMAIL_ADAPTER       mock     - cannot send"
Write-Host "    SHEET CREDENTIALS   cleared  - cannot touch your Sheet"
Write-Host ""
Write-Host "  Not included: your database (.pgdata), node_modules, .next"
Write-Host "  They double-click start.bat and it does the rest."
Write-Host ""
