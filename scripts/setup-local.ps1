param(
  [string]$PostgresPassword,
  [string]$AuthPassword = 'motel_local_auth_2026',
  [int]$Port = 5432
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$psql = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction Stop |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $PostgresPassword) { $PostgresPassword = Read-Host 'Contraseña del usuario postgres' -AsSecureString | ConvertFrom-SecureString -AsPlainText }

function Invoke-Psql([string]$Database, [string]$Sql) {
  $env:PGPASSWORD = $PostgresPassword
  & $psql -h 127.0.0.1 -p $Port -U postgres -d $Database -v ON_ERROR_STOP=1 -c $Sql
  if ($LASTEXITCODE -ne 0) { throw "No se pudo ejecutar SQL en $Database." }
}

$quotedPassword = $AuthPassword.Replace("'", "''")
$roleExists = (& $psql -h 127.0.0.1 -p $Port -U postgres -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname='motel_auth'").Trim()
if (-not $roleExists) { Invoke-Psql 'postgres' "CREATE ROLE motel_auth LOGIN PASSWORD '$quotedPassword';" }
$dbExists = (& $psql -h 127.0.0.1 -p $Port -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='motel_web_auth'").Trim()
if (-not $dbExists) { Invoke-Psql 'postgres' 'CREATE DATABASE motel_web_auth OWNER motel_auth;' }

$env:PGPASSWORD = $AuthPassword
& $psql -h 127.0.0.1 -p $Port -U motel_auth -d motel_web_auth -v ON_ERROR_STOP=1 -f (Join-Path $project 'scripts\auth.sql')
if ($LASTEXITCODE -ne 0) { throw 'No se pudo aplicar scripts/auth.sql.' }
Write-Host 'Base motel_web_auth preparada correctamente.'
