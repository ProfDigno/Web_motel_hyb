$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv-sync\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Primero instale el entorno Python .venv-sync y psycopg.' }
& $python -m PyInstaller --noconfirm --clean --onefile --windowed --name SincronizacionMotelOcupacionDetalle --distpath $project --workpath (Join-Path $project 'build\sync-gui-occupancy-detail') --specpath (Join-Path $project 'build') --paths $PSScriptRoot (Join-Path $PSScriptRoot 'sync_gui.py')
if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el ejecutable.' }
Write-Host "Ejecutable creado: $(Join-Path $project 'SincronizacionMotelOcupacionDetalle.exe')"
