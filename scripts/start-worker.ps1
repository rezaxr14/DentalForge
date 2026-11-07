<#>
.SYNOPSIS
    Start the DentalForge worker with live mode for a demo session.

.DESCRIPTION
    This script loads environment from a local uncommitted file (.env.worker),
    runs the VLM-DENTAL compatibility probe, prints the capability report,
    then starts the worker process. The worker will heartbeat to the app and
    the /status badge will update within a few seconds.

.PREREQUISITES
    - VLM-DENTAL available at $env:VLM_DENTAL_PATH (or ../vlm-dental)
    - LM Studio running with a compatible model loaded (for test backend)
    - Python venv with torch, transformers, peft, ultralytics
    - .env.worker file with required secrets (never committed)

.NOTES
    The live mode is attached only during arranged demos. Otherwise the app
    shows recorded runs. No promise of availability.
#>

param(
    [string]$VlmDentalPath = "..\vlm-dental",
    [string]$EnvFile = ".\.env.worker",
    [switch]$SkipProbe
)

$ErrorActionPreference = "Stop"

Write-Host "=== DentalForge Worker Launcher ===" -ForegroundColor Cyan

# 1. Load environment
if (-not (Test-Path $EnvFile)) {
    Write-Error "Environment file not found: $EnvFile"
    Write-Host "Create it from .env.worker.example (never commit the real one)."
    exit 1
}

$envContent = Get-Content $EnvFile -Raw
foreach ($line in $envContent -split "`r?`n") {
    $line = $line.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $parts = $line.Split("=", 2)
    if ($parts.Count -eq 2) {
        $name = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"')
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
        Write-Host "  Loaded $name" -ForegroundColor Gray
    }
}

# 2. Verify required vars
$required = @(
    "DATABASE_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "INVITE_SIGNING_SECRET",
    "WORKER_MODE"
)
foreach ($v in $required) {
    if (-not [Environment]::GetEnvironmentVariable($v, "Process")) {
        Write-Error "Missing required env var: $v"
        exit 1
    }
}

# 3. Run compatibility probe (unless skipped)
if (-not $SkipProbe) {
    Write-Host "`n=== Running VLM-DENTAL compatibility probe ===" -ForegroundColor Cyan
    $probeScript = Join-Path $VlmDentalPath "scripts\probe_compat.py"
    if (-not (Test-Path $probeScript)) {
        Write-Warning "Probe script not found at $probeScript — skipping"
    } else {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
        if (-not $python) {
            Write-Error "Python not found in PATH"
            exit 1
        }
        & $python.Source $probeScript --vlm-dental-path $VlmDentalPath
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Compatibility probe failed (exit $LASTEXITCODE)"
            exit $LASTEXITCODE
        }
        Write-Host "Probe passed." -ForegroundColor Green
    }
}

# 4. Create a scoped worker token (if not exists)
Write-Host "`n=== Checking worker token ===" -ForegroundColor Cyan
$tokenName = "live-demo-$(Get-Date -Format 'yyyyMMdd-HHmm')"
$hasToken = $false
try {
    # This would call the admin API to create/list tokens
    # For now, assume the token is pre-created and in .env.worker
    if ($env:WORKER_TOKEN) {
        Write-Host "Using WORKER_TOKEN from environment" -ForegroundColor Green
        $hasToken = $true
    }
} catch {
    Write-Warning "Could not verify token: $_"
}

if (-not $hasToken) {
    Write-Warning "No worker token found. Create one in the admin UI at /settings/workers"
    Write-Warning "Required scopes: claim, events, artifacts, ingest"
    Read-Host "Press Enter to continue anyway (worker will fail to register)..."
}

# 5. Start the worker
Write-Host "`n=== Starting worker ===" -ForegroundColor Cyan
Write-Host "The worker will heartbeat to $env:BETTER_AUTH_URL" -ForegroundColor Gray
Write-Host "Watch the /status page — badge updates within 5-10 seconds." -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop. Jobs in flight will fail cleanly; nothing is lost." -ForegroundColor Yellow

$workerEntry = Join-Path $VlmDentalPath "worker\entry.py"
if (-not (Test-Path $workerEntry)) {
    Write-Error "Worker entry not found at $workerEntry"
    exit 1
}

& $python.Source $workerEntry
$exitCode = $LASTEXITCODE

Write-Host "`n=== Worker stopped (exit $exitCode) ===" -ForegroundColor Cyan
exit $exitCode