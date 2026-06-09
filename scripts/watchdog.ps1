$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$HealthUrl = "http://localhost:1984/api/health"
$CheckInterval = 60
$LogFile = Join-Path $env:USERPROFILE ".agentara\watchdog.log"
$Bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"

$env:AGENTARA_HOME = "$env:USERPROFILE\.agentara"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp $Message" | Out-File -Append -FilePath $LogFile
    Write-Host "$timestamp $Message"
}

function Start-Agentara {
    $process = Start-Process -FilePath $Bun -ArgumentList "run index.ts" `
        -WorkingDirectory $ProjectDir -NoNewWindow -PassThru `
        -RedirectStandardOutput "$env:USERPROFILE\.agentara\server_stdout.log" `
        -RedirectStandardError "$env:USERPROFILE\.agentara\server_stderr.log"
    return $process
}

function Test-Health {
    try {
        $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5 -ErrorAction Stop
        return $response.status -eq "ok"
    } catch {
        return $false
    }
}

Write-Log "=== Watchdog started ==="
Write-Log "Project: $ProjectDir"
Write-Log "Health: $HealthUrl (check every ${CheckInterval}s)"

$process = Start-Agentara
Write-Log "Agentara started (PID: $($process.Id))"

try {
    while ($true) {
        Start-Sleep -Seconds $CheckInterval

        if ($process.HasExited) {
            Write-Log "Process exited (code: $($process.ExitCode)), restarting..."
            $process = Start-Agentara
            Write-Log "Agentara restarted (PID: $($process.Id))"
            continue
        }

        $healthy = Test-Health
        if (-not $healthy) {
            Write-Log "Health check failed, restarting..."
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            $process = Start-Agentara
            Write-Log "Agentara restarted (PID: $($process.Id))"
        }
    }
} finally {
    if ($process -and -not $process.HasExited) {
        Write-Log "Watchdog stopping, killing Agentara (PID: $($process.Id))..."
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Log "=== Watchdog stopped ==="
}
