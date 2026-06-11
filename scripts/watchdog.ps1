$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$env:AGENTARA_SERVICE_PORT = if ($env:AGENTARA_SERVICE_PORT) { $env:AGENTARA_SERVICE_PORT } else { "1985" }
$HealthUrl = "http://localhost:$env:AGENTARA_SERVICE_PORT/api/health"
$CheckInterval = 60
$LogFile = Join-Path $env:USERPROFILE ".agentara\watchdog.log"
$StderrLog = Join-Path $env:USERPROFILE ".agentara\server_stderr.log"
$Bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"

$env:AGENTARA_HOME = "$env:USERPROFILE\.agentara"

# --- backoff state ---
$CrashCount = 0
$BackoffSeconds = @(0, 5, 15, 30, 60)
$LastStableTime = [datetime]::MinValue
$MinStableSeconds = 300  # 5 min stable → reset crash counter

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp $Message" | Out-File -Append -FilePath $LogFile
    Write-Host "$timestamp $Message"
}

function Get-BackoffDelay {
    # Exponential backoff: pick delay by crash count, cap at max
    $idx = [Math]::Min($CrashCount, $BackoffSeconds.Length - 1)
    return $BackoffSeconds[$idx]
}

function Get-RecentStderr {
    $lines = @()
    if (Test-Path $StderrLog) {
        $lines = Get-Content $StderrLog -Tail 5 -ErrorAction SilentlyContinue
    }
    if ($lines) { return "`n  last stderr: " + ($lines -join "`n  ") }
    return ""
}

function Start-Agentara {
    $delay = Get-BackoffDelay
    if ($delay -gt 0) {
        Write-Log "Backoff: waiting ${delay}s before restart (crash #$CrashCount)"
        Start-Sleep -Seconds $delay
    }
    $process = Start-Process -FilePath $Bun -ArgumentList "run index.ts" `
        -WorkingDirectory $ProjectDir -NoNewWindow -PassThru `
        -RedirectStandardOutput "$env:USERPROFILE\.agentara\server_stdout.log" `
        -RedirectStandardError $StderrLog
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
$processStartTime = Get-Date
Write-Log "Agentara started (PID: $($process.Id))"

try {
    while ($true) {
        Start-Sleep -Seconds $CheckInterval

        # Reset crash counter if process has been stable long enough
        if ($CrashCount -gt 0 -and (Get-Date) -gt $LastStableTime.AddSeconds($MinStableSeconds)) {
            Write-Log "Stable for ${MinStableSeconds}s, resetting crash counter (was $CrashCount)"
            $CrashCount = 0
        }

        if ($process.HasExited) {
            $exitCode = $process.ExitCode
            $uptime = [int](Get-Date).Subtract($processStartTime).TotalSeconds
            $CrashCount++
            $stderr = Get-RecentStderr
            Write-Log "Process exited (code: $exitCode, uptime: ${uptime}s), restarting...$stderr"
            Get-Process -Name "claude" -ErrorAction SilentlyContinue | Stop-Process -Force
            $process = Start-Agentara
            $processStartTime = Get-Date
            # If process survived long enough, consider it stable
            if ($uptime -ge $MinStableSeconds) { $LastStableTime = Get-Date }
            Write-Log "Agentara restarted (PID: $($process.Id))"
            continue
        }

        $healthy = Test-Health
        if (-not $healthy) {
            $CrashCount++
            Write-Log "Health check failed, restarting (crash #$CrashCount)..."
            # Kill the entire process tree (bun + claude children) and any orphaned claude processes
            taskkill /T /F /PID $process.Id -ErrorAction SilentlyContinue | Out-Null
            Get-Process -Name "claude" -ErrorAction SilentlyContinue | Stop-Process -Force
            $process = Start-Agentara
            $processStartTime = Get-Date
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
