param(
  [string]$Project = 'C:\Users\Digno\Documents\CODEX\Web_motel_hyb',
  [string]$Key = 'C:\Users\Digno\.ssh\motel_sync_ed25519'
)
$ErrorActionPreference = 'Stop'
$csv = Join-Path $env:TEMP 'motel-occupancy.csv'
$knownHosts = 'C:\Users\Digno\.ssh\known_hosts'
$password = (Get-Content -LiteralPath (Join-Path $Project 'conexion_postgresql.txt') | Where-Object { $_ -match '^Contraseña:' } | Select-Object -First 1) -replace '^Contraseña:\s*',''
if (-not $password) { throw 'Local PostgreSQL password not found' }
$copySql = @"
\copy (
  SELECT idhabitacion_dato AS room_id,
    COALESCE(idhabitacion_recepcion_actual,0) AS reception_id,
    nro_habitacion::integer AS room_number,
    COALESCE(tipo_habitacion,'') AS room_type,
    COALESCE(estado,'') AS state,
    COALESCE(descrip_estado,estado,'') AS state_description,
    COALESCE(descripcion_habitacion,'') AS room_description,
    COALESCE(tiempo_estado,'.') AS elapsed_label,
    GREATEST(COALESCE(CASE
      WHEN estado='OCUPADO' THEN extract(epoch FROM current_timestamp-fec_ocupado_inicio)
      WHEN estado IN ('SUCIO','LIMPIANDO') THEN extract(epoch FROM current_timestamp-fec_ocupado_fin)
      ELSE 0 END,0)::integer,0) AS elapsed_seconds,
    COALESCE(monto_gral,0) AS amount,
    COALESCE(color_fondo,'#F0F0F0') AS background_color,
    COALESCE(color_texto,'#000000') AS text_color,
    CASE WHEN estado='OCUPADO' THEN fec_ocupado_inicio ELSE NULL END AS entry_at,
    COALESCE(es_por_hora,false) AS is_hour,
    COALESCE(es_por_dormir,false) AS is_sleep,
    COALESCE(es_hospedaje,false) AS is_lodging,
    COALESCE(monto_adelanto,0) AS advance,
    COALESCE(cant_hora_adicional,0) AS extra_hours,
    COALESCE(puerta_cliente,false) AS client_door,
    COALESCE(puerta_limpieza,false) AS cleaning_door,
    COALESCE(es_manual,false) AS is_manual,
    COALESCE(CASE
      WHEN es_hospedaje THEN monto_por_hospedaje_minimo
      WHEN es_por_dormir THEN monto_por_dormir_minimo
      WHEN es_por_hora THEN monto_por_hora_minimo
      ELSE 0 END,0) AS minimum_amount,
    COALESCE(CASE
      WHEN es_hospedaje THEN 0
      WHEN es_por_dormir THEN monto_por_dormir_adicional
      WHEN es_por_hora THEN monto_por_hora_adicional
      ELSE 0 END,0) AS additional_unit_amount,
    COALESCE(monto_consumision,0) AS consumption_amount,
    COALESCE(orden,0) AS sort_order,
    current_timestamp AS source_at
  FROM habitacion_recepcion_temp
  WHERE activo=true
  ORDER BY orden,nro_habitacion
) TO STDOUT WITH (FORMAT CSV, HEADER true, ENCODING 'UTF8')
"@
try {
  $env:PGPASSWORD = $password
  & 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -w -q -h 127.0.0.1 -p 5432 -U postgres -d bddaomotelkm8_23 -c $copySql -o $csv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $csv) -or (Get-Item -LiteralPath $csv).Length -lt 100) { throw 'Occupancy export failed' }
  Remove-Item Env:PGPASSWORD
  & scp -i $Key -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" $csv 'motel-sync@163.245.222.236:/home/motel-sync/occupancy.csv'
  if ($LASTEXITCODE -ne 0) { throw 'Occupancy upload failed' }
  & ssh -i $Key -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" 'motel-sync@163.245.222.236' 'sudo /opt/motel-web/scripts/import-occupancy.sh'
  if ($LASTEXITCODE -ne 0) { throw 'Remote occupancy import failed' }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $csv -Force -ErrorAction SilentlyContinue
}
