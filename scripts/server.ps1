# ══════════════════════════════════════════════════════════════════════════
#  Start / stop the production server without blocking the terminal.
#
#  Why this file exists
#  ─────────────────────
#  `Start-Process -NoNewWindow` does NOT detach a process on Windows. It inherits the
#  parent console's standard input, output and error handles, so the calling shell
#  cannot return until every child releases them. Since a web server never exits, the
#  terminal hangs forever, and no amount of piping to Select-Object helps.
#
#  Redirecting the streams to files is not enough either — the parent still holds a
#  handle to the child process, and some hosts wait on the whole process group.
#
#  The fix is to create the process through WMI. `Win32_Process.Create` builds the
#  process with no console and no inherited handles, so this script returns immediately
#  and the server keeps running independently.
#
#  Usage
#    powershell -File scripts/server.ps1 start
#    powershell -File scripts/server.ps1 stop
#    powershell -File scripts/server.ps1 status
#    powershell -File scripts/server.ps1 restart
#
#  Or, from package.json, which is the intended path:
#    npm run serve          start in the background, wait until healthy
#    npm run serve:stop
# ══════════════════════════════════════════════════════════════════════════

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status')]
    [string]$Action = 'status',

    [int]$Port = 3000,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$NextBin = Join-Path $ProjectRoot 'node_modules\next\dist\bin\next'
$LogOut = Join-Path $env:TEMP 'daydial-server.log'
$LogErr = Join-Path $env:TEMP 'daydial-server.err'

if (-not (Test-Path $NextBin)) {
    Write-Host "next is not installed. Run: npm install" -ForegroundColor Red
    exit 1
}

function Get-ServerProcess {
    # Matches only this project's server, so an unrelated `next dev` is left alone.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*next*start*" -and $_.CommandLine -like "*$Port*" }
}

function Stop-Server {
    $procs = @(Get-ServerProcess)
    if ($procs.Count -eq 0) {
        Write-Host "nothing running on port $Port"
        return
    }
    foreach ($p in $procs) {
        Write-Host "stopping pid $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 700
}

function Test-Healthy {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port" -UseBasicParsing -TimeoutSec 4
        return $r.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Start-Server {
    if (Test-Healthy) {
        Write-Host "already serving on http://localhost:$Port"
        return
    }

    # `cd /d` first, because Win32_Process.Create has no working-directory parameter and
    # otherwise runs in C:\Windows\System32 — where `next start` finds no .next and exits
    # with "Could not find a production build". The `2>&1` merges both streams into one
    # log so a failure has everything in one place.
    $commandLine = "cmd /c `"cd /d `"$ProjectRoot`" && node `"$NextBin`" start -p $Port >> `"$LogOut`" 2>&1`""

    # WMI, not Start-Process. This is the whole point of the script.
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }

    if ($result.ReturnValue -ne 0) {
        Write-Host "failed to start (WMI returned $($result.ReturnValue))" -ForegroundColor Red
        exit 1
    }

    Write-Host "pid $($result.ProcessId) starting; waiting for http://localhost:$Port"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Healthy) {
            Write-Host "ready on http://localhost:$Port" -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 500
    }

    Write-Host "did not become healthy within ${TimeoutSeconds}s" -ForegroundColor Red
    Write-Host "--- last 30 log lines ---" -ForegroundColor Yellow
    if (Test-Path $LogOut) { Get-Content $LogOut -Tail 30 }
    if (Test-Path $LogErr) { Get-Content $LogErr -Tail 30 }
    exit 1
}

switch ($Action) {
    'start'   { Start-Server }
    'stop'    { Stop-Server }
    'restart' { Stop-Server; Start-Server }
    'status'  {
        $procs = @(Get-ServerProcess)
        if ($procs.Count -gt 0 -and (Test-Healthy)) {
            Write-Host "serving on http://localhost:$Port (pid $($procs[0].ProcessId))" -ForegroundColor Green
        }
        elseif ($procs.Count -gt 0) {
            Write-Host "process exists (pid $($procs[0].ProcessId)) but not responding"
        }
        else {
            Write-Host "not running"
        }
    }
}