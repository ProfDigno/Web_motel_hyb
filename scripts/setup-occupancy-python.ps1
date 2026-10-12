$ErrorActionPreference = 'Stop'
$project = 'C:\Users\Digno\Documents\CODEX\Web_motel_hyb'
$venv = Join-Path $project '.venv-sync'
$passFile = Join-Path $project 'scripts\.occupancy-sync.pgpass'
$rootCredentialFile = Join-Path $project 'conexion.txt'
$plink = 'C:\Program Files\PuTTY\plink.exe'
$hostKey = 'SHA256:WgNEJySuVDOJy1SR7/OAuq5pw+5+wROhF1VbYIFUOqY'

$rootPassword = (Get-Content -LiteralPath $rootCredentialFile | Where-Object { $_ -match '^Contraseña:' } | Select-Object -First 1) -replace '^Contraseña:\s*',''
if (-not $rootPassword) { throw 'No se encontró la contraseña administrativa del VPS.' }

$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$syncPassword = [Convert]::ToBase64String($bytes).Replace('+','A').Replace('/','B').TrimEnd('=')
$remoteTemplate = @'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motel_occupancy_sync') THEN
    CREATE ROLE motel_occupancy_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
ALTER ROLE motel_occupancy_sync PASSWORD '__SYNC_PASSWORD__';
ALTER ROLE motel_occupancy_sync SET search_path=public;
GRANT CONNECT ON DATABASE motel_web_auth TO motel_occupancy_sync;
GRANT USAGE ON SCHEMA public TO motel_occupancy_sync;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM motel_occupancy_sync;
GRANT SELECT,INSERT,DELETE,TRUNCATE ON occupancy_snapshot TO motel_occupancy_sync;
'@
$remoteSetup = $remoteTemplate.Replace('__SYNC_PASSWORD__', $syncPassword)

try {
  $remoteSetup | & $plink -batch -hostkey $hostKey -pw $rootPassword root@163.245.222.236 'sudo -u postgres psql -d motel_web_auth -v ON_ERROR_STOP=1 -f -'
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el usuario limitado en el VPS.' }

  [IO.File]::WriteAllText($passFile, "127.0.0.1:55432:motel_web_auth:motel_occupancy_sync:$syncPassword`n", [Text.UTF8Encoding]::new($false))
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $passFile /inheritance:r | Out-Null
  & icacls.exe $passFile /grant:r "${identity}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'No se pudieron restringir los permisos del archivo de conexión.' }

  if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) {
    & py -3 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el entorno Python.' }
  }
  & (Join-Path $venv 'Scripts\python.exe') -m pip install --disable-pip-version-check -r (Join-Path $project 'scripts\requirements-occupancy.txt')
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo instalar psycopg.' }

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'Iniciar sincronizacion ocupacion.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $env:ComSpec
  $shortcut.Arguments = "/c `"$project\scripts\start-occupancy-sync.cmd`""
  $shortcut.WorkingDirectory = $project
  $shortcut.Description = 'Inicia la sincronización continua de ocupación e informes'
  $shortcut.Save()
  Write-Host "Configuración terminada. Acceso directo: $shortcutPath"
} finally {
  $rootPassword = $null
  $syncPassword = $null
  $remoteSetup = $null
}
