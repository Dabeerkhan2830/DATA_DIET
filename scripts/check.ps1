# Runs every automated check in the repository.
#   .\scripts\check.ps1
# Exits non-zero on the first failure and restores the caller's working
# directory even when a step fails.
#
# Native command failures (ruff, pytest, npm) do not throw on their own — in
# Windows PowerShell the ErrorActionPreference does not cover exit codes — so
# every step is followed by an explicit exit-code check. The checks throw a
# controlled exception instead of calling exit, so the finally block can
# restore the original location; the exact native exit code is preserved for
# the final process exit.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
$originalLocation = (Get-Location).Path
$script:checkExitCode = 0

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        $failedCode = $LASTEXITCODE
        Write-Host "$Step failed with exit code $failedCode." -ForegroundColor Red
        $script:checkExitCode = $failedCode
        throw "$Step failed; stopping the check gate."
    }
}

try {
    if (-not (Test-Path $python)) {
        throw "Virtual environment not found at $python. See docs/setup.md to create it."
    }

    Write-Host "== Backend lint (ruff) ==" -ForegroundColor Cyan
    Set-Location (Join-Path $repoRoot "backend")
    & $python -m ruff check .
    Assert-LastExitCode "Backend lint (ruff)"

    # Operator scripts live outside backend/ but use the same Ruff configuration
    # (line length, rules). Linting them here keeps the gate and CI in parity;
    # the formatter stays out of the gate on purpose (see AGENTS.md).
    Write-Host "== Operator scripts lint (ruff) ==" -ForegroundColor Cyan
    & $python -m ruff check ..\scripts
    Assert-LastExitCode "Operator scripts lint (ruff)"

    Write-Host "== Backend tests (pytest) ==" -ForegroundColor Cyan
    & $python -m pytest
    Assert-LastExitCode "Backend tests (pytest)"

    Write-Host "== Frontend type check (tsc) ==" -ForegroundColor Cyan
    Set-Location (Join-Path $repoRoot "frontend")
    npm run typecheck
    Assert-LastExitCode "Frontend type check (tsc)"

    Write-Host "== Frontend tests (vitest) ==" -ForegroundColor Cyan
    npm test
    Assert-LastExitCode "Frontend tests (vitest)"

    Write-Host "== Frontend production build ==" -ForegroundColor Cyan
    npm run build
    Assert-LastExitCode "Frontend production build"
}
catch {
    if ($script:checkExitCode -eq 0) {
        $script:checkExitCode = 1
    }
    Write-Host $_.Exception.Message -ForegroundColor Red
}
finally {
    Set-Location $originalLocation
}

if ($script:checkExitCode -ne 0) {
    exit $script:checkExitCode
}

Write-Host "All checks passed." -ForegroundColor Green
