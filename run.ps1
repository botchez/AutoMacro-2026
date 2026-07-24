#!/usr/bin/env pwsh
# One-command launcher for NutriCoach.
# Bootstraps the Python venv + npm deps if missing, builds the frontend, then
# serves the whole app (API + UI) from a single FastAPI process on port 8000.
#
#   Production (default):  .\run.ps1          -> build + serve on http://localhost:8000
#   Development:           .\run.ps1 -Dev     -> API (:8000) + Vite dev server (:5173)

param([switch]$Dev)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$py = ".\.venv\Scripts\python.exe"

# 1. Python venv
if (-not (Test-Path $py)) {
    Write-Host "Creating virtualenv..." -ForegroundColor Cyan
    python -m venv .venv
}

# 2. Python deps (install if fastapi is missing)
& $py -c "import fastapi" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing Python dependencies..." -ForegroundColor Cyan
    & $py -m pip install -r requirements.txt
}

# 3. Node deps
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    npm install
}

if ($Dev) {
    Write-Host "Starting API (:8000) and Vite dev server (:5173)..." -ForegroundColor Green
    Start-Process npm -ArgumentList "run","dev:api"
    npm run dev
} else {
    Write-Host "Building frontend..." -ForegroundColor Cyan
    npm run build
    Write-Host "Serving on http://localhost:8000 (API docs at /api/docs)" -ForegroundColor Green
    & $py -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
}
