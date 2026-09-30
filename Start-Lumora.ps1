$ErrorActionPreference = 'Stop'
$lumoraRoot = $PSScriptRoot
$runtimeDir = Join-Path $lumoraRoot '.runtime'
$supervisorPath = Join-Path $lumoraRoot 'scripts/supervisor.mjs'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$recordPath = Join-Path $runtimeDir 'processes.json'
if (Test-Path -LiteralPath $recordPath) {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.supervisor)"
    if ($running -and $running.CommandLine.Contains($supervisorPath)) {
        Write-Output 'Lumora is already running at http://127.0.0.1:3000'; exit 0
    }
}
if (!(Test-Path -LiteralPath (Join-Path $lumoraRoot 'frontend/.next/BUILD_ID')) -or !(Test-Path -LiteralPath (Join-Path $lumoraRoot 'backend/dist/server.js'))) {
    throw 'Run npm install and npm run build from the lumora folder first.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $nodePath -ArgumentList ('"' + $supervisorPath + '"') -WorkingDirectory $lumoraRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'supervisor.out.log') -RedirectStandardError (Join-Path $runtimeDir 'supervisor.err.log') | Out-Null
Write-Output 'Lumora is starting at http://127.0.0.1:3000. Logs: .runtime/backend.log and frontend.log'
