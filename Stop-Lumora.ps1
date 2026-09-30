$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $PSScriptRoot '.runtime'
$recordPath = Join-Path $runtimeDir 'processes.json'
if (!(Test-Path -LiteralPath $recordPath)) { Write-Output 'Lumora is not running under the launcher.'; exit 0 }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$supervisorPath = Join-Path $PSScriptRoot 'scripts/supervisor.mjs'
$running = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.supervisor)"
if (!$running -or !$running.CommandLine.Contains($supervisorPath)) { Write-Output 'No matching Lumora supervisor is running.'; exit 0 }
Set-Content -LiteralPath (Join-Path $runtimeDir 'stop.request') -Value 'stop'
Write-Output 'Lumora is stopping. Saved torrents and downloaded files are retained.'
