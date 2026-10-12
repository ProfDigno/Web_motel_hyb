param(
  [string]$Project = 'C:\Users\Digno\Documents\CODEX\Web_motel_hyb',
  [string]$Key = 'C:\Users\Digno\.ssh\motel_sync_ed25519'
)
$ErrorActionPreference = 'Stop'
$dump = Join-Path $env:TEMP 'motel-hourly.dump'
$knownHosts = 'C:\Users\Digno\.ssh\known_hosts'
$password = (Get-Content -LiteralPath (Join-Path $Project 'conexion_postgresql.txt') | Where-Object { $_ -match '^Contraseña:' } | Select-Object -First 1) -replace '^Contraseña:\s*',''
if (-not $password) { throw 'Local PostgreSQL password not found' }
try {
  $env:PGPASSWORD = $password
  & 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe' -w -h 127.0.0.1 -p 5432 -U postgres -d bddaomotelkm8_23 -Fc -Z 6 -f $dump
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
  Remove-Item Env:PGPASSWORD
  & scp -i $Key -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" $dump 'motel-sync@163.245.222.236:/home/motel-sync/incoming.dump'
  if ($LASTEXITCODE -ne 0) { throw 'SCP failed' }
  & ssh -i $Key -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" 'motel-sync@163.245.222.236' 'sudo /opt/motel-web/scripts/import-report.sh'
  if ($LASTEXITCODE -ne 0) { throw 'Remote import failed' }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $dump -Force -ErrorAction SilentlyContinue
}
