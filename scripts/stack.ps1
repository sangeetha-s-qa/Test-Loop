<#
.SYNOPSIS
  Start, stop, or check the local QualityOS production stack.

.DESCRIPTION
  Runs the built output in dist/, which is what production uses. Matching on the launch command
  is deliberate: the workers start as `node dist/<area>/worker.js`, a relative path that does not
  contain the project directory, so a naive filter on the project name silently matches nothing
  and leaves a previous stack running. Duplicate workers then race for the same BullMQ jobs, and
  an older build can win.

.EXAMPLE
  pwsh scripts/stack.ps1 start
  pwsh scripts/stack.ps1 status
  pwsh scripts/stack.ps1 stop
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$logDir = Join-Path $root 'logs'

# Matches every process this script can start, however it was launched.
$pattern = 'dist[\\/](server|fixture[\\/]server|(ai|automation|execution|analysis|discovery)[\\/]worker)\.js|TestLoop[\\/]frontend'

$services = @(
  @{ Name = 'api';        Script = 'dist/server.js' }
  @{ Name = 'fixture';    Script = 'dist/fixture/server.js' }
  @{ Name = 'discovery';  Script = 'dist/discovery/worker.js' }
  @{ Name = 'ai';         Script = 'dist/ai/worker.js' }
  @{ Name = 'automation'; Script = 'dist/automation/worker.js' }
  @{ Name = 'execution';  Script = 'dist/execution/worker.js' }
  @{ Name = 'analysis';   Script = 'dist/analysis/worker.js' }
)

function Get-StackProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern }
}

function Stop-Stack {
  $procs = @(Get-StackProcesses)
  Write-Host "Stopping $($procs.Count) process(es)..."
  foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }

  # Wait for the ports to actually free; a start that races a shutdown produces duplicates.
  foreach ($i in 1..15) {
    Start-Sleep -Milliseconds 400
    $busy = @(3000, 4000, 4317 | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
    if (@(Get-StackProcesses).Count -eq 0 -and $busy.Count -eq 0) { Write-Host 'Stopped.'; return }
  }
  Write-Warning 'Some processes or ports did not release cleanly.'
}

function Start-Stack {
  if (@(Get-StackProcesses).Count -gt 0) { throw 'A stack is already running. Use "restart" or "stop" first.' }
  if (-not (Test-Path (Join-Path $backend 'dist/server.js'))) { throw 'dist/ is missing. Run: npm run build' }

  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  foreach ($s in $services) {
    $log = Join-Path $logDir "$($s.Name).log"
    Start-Process -FilePath 'node' -ArgumentList $s.Script -WorkingDirectory $backend `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden | Out-Null
  }
  # npm is a .cmd shim on Windows; Start-Process needs the actual executable.
  $npm = if ($IsWindows -ne $false) { 'npm.cmd' } else { 'npm' }
  Start-Process -FilePath $npm -ArgumentList 'run', 'start' -WorkingDirectory $frontend `
    -RedirectStandardOutput (Join-Path $logDir 'frontend.log') -RedirectStandardError (Join-Path $logDir 'frontend.log.err') -WindowStyle Hidden | Out-Null

  Write-Host 'Waiting for services...'
  foreach ($i in 1..90) {
    Start-Sleep -Seconds 1
    $ok = $true
    foreach ($u in 'http://localhost:4000/health', 'http://127.0.0.1:4317/', 'http://localhost:3000/') {
      try { Invoke-WebRequest -Uri $u -TimeoutSec 3 -UseBasicParsing | Out-Null } catch { $ok = $false; break }
    }
    if ($ok) { Write-Host 'Stack up.'; Show-Status; return }
  }
  throw "Services did not become healthy. Check $logDir."
}

function Show-Status {
  $procs = @(Get-StackProcesses)
  Write-Host "Processes: $($procs.Count) (expected 8: api, fixture, 5 workers, frontend)"
  if ($procs.Count -gt 8) { Write-Warning 'More processes than expected - duplicate workers will race for the same jobs.' }
  foreach ($u in 'http://localhost:3000/', 'http://localhost:4000/health', 'http://127.0.0.1:4317/') {
    try { $r = Invoke-WebRequest -Uri $u -TimeoutSec 3 -UseBasicParsing; "  {0,-34} {1}" -f $u, $r.StatusCode }
    catch { "  {0,-34} DOWN" -f $u }
  }
}

switch ($Action) {
  'start'   { Start-Stack }
  'stop'    { Stop-Stack }
  'restart' { Stop-Stack; Start-Stack }
  'status'  { Show-Status }
}
