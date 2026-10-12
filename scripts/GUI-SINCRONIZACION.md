# Sincronización Motel en otra PC

`SincronizacionMotelAltaAutomatica.exe` abre una ventana para cambiar el origen PostgreSQL, el VPS, las rutas de SSH y `pg_dump`, y los intervalos. El botón **Mostrar contraseñas** permite ver o volver a ocultar las dos claves de PostgreSQL en la pantalla. **Guardar parámetros** conserva esas claves en archivos separados, restringidos al usuario actual de Windows. No cambia ninguna contraseña del VPS.

La pestaña **Actividad reciente** muestra el registro de habitaciones e informes en un área grande y desplazable. Los controles de inicio, parada y el estado permanecen visibles debajo de las pestañas.

## Preparación

1. Copie `SincronizacionMotelAltaAutomatica.exe` a una carpeta estable de la nueva PC. No hace falta copiar `.venv-sync`; el ejecutable contiene Python, `psycopg` y `paramiko`.
2. Instale el cliente PostgreSQL con `pg_dump.exe` de versión compatible con la base origen. Instale o habilite el cliente OpenSSH de Windows (`ssh` y `scp`).
3. En la pestaña **VPS**, pulse **Autorizar esta PC**. Ingrese el usuario SSH de administrador con `sudo` y su contraseña. El programa genera una clave local si hace falta, comprueba la identidad del VPS con la huella ED25519 fijada, agrega la clave pública a `motel-sync`, registra `known_hosts` y prueba SSH. La contraseña de administrador solo se usa durante el alta y no se guarda. También están disponibles **Crear clave de esta PC**, **Ver clave pública** y **Registrar VPS seguro** para diagnóstico. Nunca envíe ni incorpore una clave privada al ejecutable.
4. Abra el ejecutable y complete los campos de **PC local** y **VPS**. Si la base Java sigue en otra PC, use una conexión privada por LAN o VPN; no abra PostgreSQL a Internet.
5. Introduzca la contraseña local y la contraseña del usuario PostgreSQL de sincronización del VPS. Si no conoce esta última, deberá prepararla en el VPS antes de probar la conexión. Este programa no cambia la contraseña remota.
6. Pulse **Guardar parámetros**, luego **Probar base local**, **Probar SSH** y **Probar base VPS**. Las tres pruebas son de solo lectura. Si cambia la clave de host del VPS, deberá verificar la nueva huella por un canal independiente y actualizar la aplicación; no desactive la verificación SSH. El usuario administrador SSH necesita autorización `sudo` para ejecutar Python en el VPS.
7. Detenga el sincronizador de la PC anterior antes de pulsar **Iniciar sincronización** en la nueva PC. Deje abierto el ejecutable si desea ver la actividad; si cierra la ventana, el proceso puede seguir funcionando en segundo plano. Vuelva a abrir el programa para detenerlo.

El programa escribe `scripts/sync-config.json`, `scripts/.local-sync-password`, `scripts/.occupancy-sync.pgpass`, `logs/occupancy-sync.log` y `sync-state/python-report-sync.json` junto al ejecutable. No publique ni comparta los archivos de contraseña. Si mueve también el archivo de estado, la copia horaria conserva su próximo horario; si no lo mueve, comienza una copia de informes al iniciar.

La base local de Java sigue siendo la fuente de datos. La pantalla web conserva la última instantánea válida si falla una sincronización.
