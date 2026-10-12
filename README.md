# Motel · Panel de informes

Aplicación Node.js, Express, TypeScript y React para consultar dashboard de ventas, ocupación, productos y cierres de caja, además de administrar cuentas exclusivas de la web. Los usuarios de Java permanecen en la base de informes solo para identificar al cajero histórico.

## Acceso

Producción: https://163.245.222.236/

El login consulta únicamente `motel_web_auth.usuario_web`, con contraseñas protegidas mediante hashes bcrypt. Solo pide usuario (texto) y contraseña de al menos 8 caracteres. No exige cambios periódicos ni códigos de autenticador. El cambio de contraseña es voluntario desde **Mi contraseña**. Los administradores eligen la contraseña al crear cada cuenta; las cuentas `consulta` acceden a informes, pero no administran usuarios. Los cambios de clave, perfil o estado invalidan las sesiones anteriores.

No se importan cuentas ni contraseñas de Java. La tabla antigua `web_user` se retira de la base de autenticación después de respaldarla. Las tablas de Java no se modifican en la PC.

## Datos y sincronización

La base `bddaomotelkm8_23` de esta PC es la fuente. El proceso Python envía cada hora una copia completa por SSH con la clave `C:\Users\Digno\.ssh\motel_sync_ed25519`. En el VPS, `scripts/import-report.sh` restaura primero una base temporal, borra `usuario.password` en esa copia, verifica los cierres y cambia la base de informes. Conserva la copia anterior para recuperación. La base de autenticación no se reemplaza. La interfaz muestra la hora de la última sincronización correcta.

La ocupación y los informes se sincronizan mediante `scripts/sync_occupancy.py`. Se inicia manualmente con el acceso directo **Iniciar sincronizacion ocupacion** del escritorio y mantiene una sola terminal visible. Cada minuto consulta las habitaciones activas de `habitacion_recepcion_temp` y actualiza directamente `motel_web_auth.occupancy_snapshot` mediante PostgreSQL y un túnel SSH persistente. En paralelo, cada hora crea la copia completa para informes, la restaura y valida en el VPS antes de reemplazar la base publicada. Una falla conserva los últimos datos válidos y se reintenta automáticamente. PostgreSQL del VPS permanece cerrado a Internet y el usuario remoto directo solo tiene permisos sobre la tabla de ocupación.

El entorno aislado está en `.venv-sync` y el registro de diagnóstico en `logs/occupancy-sync.log`. `Ctrl+C` detiene ambos trabajos. Las tareas antiguas `Motel Occupancy Sync` y `Motel Web Sync` quedan deshabilitadas después de verificar Python; sus scripts PowerShell se conservan únicamente para reversión.

## Desarrollo

Instalar dependencias con `npm install`, configurar `REPORT_DATABASE_URL`, `AUTH_DATABASE_URL`, `SESSION_SECRET` y `PUBLIC_ORIGIN`, y ejecutar `npm run dev`. `npm run check` verifica tipos y `npm run build` genera `dist/server` y `dist/web`. La configuración de ejemplo está en `.env.example`; nunca colocar credenciales reales en el repositorio.

## Operación del VPS

El servicio nuevo es `motel-web.service`. Nginx sirve HTTPS en la IP pública y redirige HTTP. `motel-cert-renew.timer` comprueba la renovación del certificado dos veces al día; la renovación por webroot se probó con `--dry-run`. El servicio anterior `hotel-pms.service` está detenido y deshabilitado, pero sus archivos y configuración permanecen disponibles.

Para revertir esta versión, restaurar primero el respaldo de `motel_web_auth` y la versión anterior de `/opt/motel-web/dist`, reiniciar `motel-web.service` y comprobar el sitio. Para volver al sitio anterior, detener `motel-web`, habilitar e iniciar `hotel-pms`, cambiar el enlace activo de `/etc/nginx/sites-enabled/motel-web` a `/etc/nginx/sites-enabled/hotel-pms`, comprobar `nginx -t` y recargar Nginx.
