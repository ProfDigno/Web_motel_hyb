import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import { attachAuth } from './auth.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const reportUrl = process.env.REPORT_DATABASE_URL;
const authUrl = process.env.AUTH_DATABASE_URL;
const secret = process.env.SESSION_SECRET;
if (!reportUrl || !authUrl || !secret || secret.length < 32) throw new Error('Missing database URLs or SESSION_SECRET (min 32 characters)');
const report = new Pool({ connectionString: reportUrl, max: 10 });
const auth = new Pool({ connectionString: authUrl, max: 5 });
const directLocalOccupancy = process.env.LOCAL_OCCUPANCY_DIRECT === 'true' && process.env.NODE_ENV !== 'production';
report.on('error', error => { console.error('Conexión de informes cerrada; se abrirá otra cuando sea necesaria:', error.message); });
auth.on('error', error => { console.error('Conexión de acceso cerrada; se abrirá otra cuando sea necesaria:', error.message); });
const PgStore = connectPgSimple(session);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((_req,res,next) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"); next(); });
app.use(express.json({ limit: '16kb' }));
app.use(session({ store: new PgStore({ pool: auth, createTableIfMissing: false }), secret, resave: false, saveUninitialized: false, name: 'motel.sid', cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } }));

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const int = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : fallback; };
const safeDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const safeString = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 100) : '';
const dashboardDate = (value: unknown, fallback: string) => {
  const text = value === undefined ? fallback : value;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? text : null;
};

const localOccupancySql = `SELECT idhabitacion_dato AS room_id,
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
ORDER BY orden,nro_habitacion`;
const occupancyColumns = ['room_id','reception_id','room_number','room_type','state','state_description','room_description','elapsed_label','elapsed_seconds','amount','background_color','text_color','entry_at','is_hour','is_sleep','is_lodging','advance','extra_hours','client_door','cleaning_door','is_manual','minimum_amount','additional_unit_amount','consumption_amount','sort_order','source_at'];

async function refreshLocalOccupancy() {
  if (!directLocalOccupancy) return;
  const rows = (await report.query(localOccupancySql)).rows;
  const client = await auth.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE occupancy_snapshot');
    const placeholders = occupancyColumns.map((_, index) => `$${index + 1}`).join(',');
    const insert = `INSERT INTO occupancy_snapshot (${occupancyColumns.join(',')}) VALUES (${placeholders})`;
    for (const row of rows) await client.query(insert, occupancyColumns.map(column => row[column]));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

attachAuth(app, auth);

app.get('/api/status', wrap(async (_req, res) => {
  const result = await auth.query('SELECT finished_at, source_count, report_count FROM sync_run ORDER BY finished_at DESC LIMIT 1');
  res.json({ sync: result.rows[0] || null });
}));
app.get('/api/occupancy', wrap(async (_req, res) => {
  res.setHeader('Cache-Control','no-store, max-age=0');
  await refreshLocalOccupancy();
  const result = await auth.query(`SELECT room_id AS id,reception_id,room_number,room_type,state,state_description,
    room_description,elapsed_label,elapsed_seconds,amount,background_color,text_color,entry_at,is_hour,is_sleep,
    is_lodging,advance,extra_hours,client_door,cleaning_door,is_manual,minimum_amount,
    additional_unit_amount,consumption_amount,sort_order,source_at
    FROM occupancy_snapshot ORDER BY sort_order,room_number`);
  let rows = result.rows;
  if (!directLocalOccupancy && rows.some(row => row.state === 'OCUPADO' && Number(row.minimum_amount) === 0 && Number(row.additional_unit_amount) === 0 && Number(row.consumption_amount) === 0)) {
    const financial = await report.query(`SELECT COALESCE(idhabitacion_recepcion_actual,0) AS reception_id,
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
      COALESCE(monto_consumision,0) AS consumption_amount
      FROM habitacion_recepcion_temp WHERE activo=true AND COALESCE(idhabitacion_recepcion_actual,0)>0`);
    const byReception = new Map(financial.rows.map(row => [String(row.reception_id), row]));
    rows = rows.map(row => {
      const fallback = byReception.get(String(row.reception_id));
      const missing = row.state === 'OCUPADO' && Number(row.minimum_amount) === 0 && Number(row.additional_unit_amount) === 0 && Number(row.consumption_amount) === 0;
      return missing && fallback ? { ...row, minimum_amount:fallback.minimum_amount, additional_unit_amount:fallback.additional_unit_amount, consumption_amount:fallback.consumption_amount } : row;
    });
  }
  const syncedAt = rows[0]?.source_at || null;
  const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  res.json({
    syncedAt,
    stale: !syncedAt || Date.now() - new Date(syncedAt).getTime() > 120000,
    rows: rows.map(row => ({ ...row, background_color:color(row.background_color,'#F0F0F0'), text_color:color(row.text_color,'#000000') }))
  });
}));
app.get('/api/occupancy/:receptionId/details', wrap(async (req, res) => {
  const receptionId = int(req.params.receptionId);
  if (!receptionId) { res.status(400).json({ error: 'Recepción inválida.' }); return; }
  const current = await report.query(`SELECT estado FROM habitacion_recepcion_temp
    WHERE idhabitacion_recepcion_actual=$1 AND activo=true LIMIT 1`, [receptionId]);
  if (!current.rowCount || current.rows[0].estado !== 'OCUPADO') {
    res.status(409).json({ error: 'La habitación ya no está ocupada.' }); return;
  }
  const [observations, items] = await Promise.all([
    report.query(`SELECT v.idventa AS venta_id,v.fecha_creado,COALESCE(v.observacion,'') AS observacion
      FROM venta v WHERE v.fk_idhabitacion_recepcion=$1
      AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO')
      AND NULLIF(btrim(v.observacion),'') IS NOT NULL ORDER BY v.fecha_creado,v.idventa`, [receptionId]),
    report.query(`SELECT vi.idventa_item,vi.fk_idventa AS venta_id,vi.fecha_creado,
      COALESCE(vi.descripcion,'') AS descripcion,vi.cantidad,vi.precio_venta,
      COALESCE(vi.cantidad,0)*COALESCE(vi.precio_venta,0) AS subtotal
      FROM venta v JOIN venta_item vi ON vi.fk_idventa=v.idventa
      WHERE v.fk_idhabitacion_recepcion=$1
      AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO')
      AND COALESCE(vi.tipo_item,'') NOT IN ('CANCELADO','ANULADO')
      ORDER BY vi.fecha_creado,vi.idventa_item`, [receptionId])
  ]);
  res.json({ observations: observations.rows, items: items.rows });
}));
app.get('/api/dashboard', wrap(async (req, res) => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const first = `${today.slice(0, 8)}01`;
  const from = dashboardDate(req.query.from, first);
  const to = dashboardDate(req.query.to, today);
  if (!from || !to || from > to) { res.status(400).json({ error: 'El rango de fechas no es válido.' }); return; }
  const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (rangeDays > 730) { res.status(400).json({ error: 'El rango máximo permitido es de dos años.' }); return; }
  const values = [from, to];
  const salesWhere = `v.fecha_creado >= $1::date AND v.fecha_creado < $2::date + INTERVAL '1 day'`;
  const occupancyWhere = `hr.fec_ocupado_inicio >= $1::date AND hr.fec_ocupado_inicio < $2::date + INTERVAL '1 day'`;
  const [totals, daily, payments, paymentForms, rooms, durations, heatmap, products, productsByAmount, categories, states] = await Promise.all([
    report.query(`WITH sales AS (
      SELECT monto_minimo, monto_adicional * COALESCE(cant_adicional,0) AS adicional, monto_consumo, monto_adelanto, monto_descuento
      FROM venta v WHERE ${salesWhere} AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO')
    ) SELECT count(*)::int AS sales,
      COALESCE(sum(monto_minimo),0) AS minimo, COALESCE(sum(adicional),0) AS adicional,
      COALESCE(sum(monto_consumo),0) AS consumo, COALESCE(sum(monto_adelanto),0) AS adelanto,
      COALESCE(sum(monto_descuento),0) AS descuento,
      COALESCE(sum(monto_minimo+adicional+monto_consumo-monto_descuento),0) AS total,
      COALESCE(sum(monto_minimo+adicional+monto_consumo-monto_descuento-monto_adelanto),0) AS neto
      FROM sales`, values),
    report.query(`WITH days AS (SELECT generate_series($1::date,$2::date,'1 day')::date AS day), sales AS (
      SELECT v.fecha_creado::date AS day,count(*)::int AS sales,sum(v.monto_minimo) AS minimo,
        sum(v.monto_adicional*COALESCE(v.cant_adicional,0)) AS adicional,sum(v.monto_consumo) AS consumo,
        sum(v.monto_adelanto) AS adelanto,sum(v.monto_descuento) AS descuento,
        sum(v.monto_minimo+v.monto_adicional*COALESCE(v.cant_adicional,0)+v.monto_consumo-v.monto_descuento) AS total
      FROM venta v WHERE ${salesWhere} AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO') GROUP BY v.fecha_creado::date
    ), occ AS (SELECT hr.fec_ocupado_inicio::date AS day,count(*)::int AS occupations FROM habitacion_recepcion hr WHERE ${occupancyWhere} GROUP BY hr.fec_ocupado_inicio::date)
    SELECT d.day,COALESCE(s.sales,0) AS sales,COALESCE(o.occupations,0) AS occupations,
      COALESCE(s.minimo,0) AS minimo,COALESCE(s.adicional,0) AS adicional,COALESCE(s.consumo,0) AS consumo,
      COALESCE(s.adelanto,0) AS adelanto,COALESCE(s.descuento,0) AS descuento,COALESCE(s.total,0) AS total
    FROM days d LEFT JOIN sales s ON s.day=d.day LEFT JOIN occ o ON o.day=d.day ORDER BY d.day`, values),
    report.query(`SELECT COALESCE(sum(cd.monto_ingreso_efectivo),0) AS efectivo,COALESCE(sum(cd.monto_ingreso_tarjeta),0) AS tarjeta,
      COALESCE(sum(cd.monto_ingreso_transferencia),0) AS transferencia
      FROM caja_cierre_detalle cd WHERE cd.fecha_creado >= $1::date AND cd.fecha_creado < $2::date + INTERVAL '1 day' AND COALESCE(cd.es_caja,true)`, values),
    report.query(`SELECT COALESCE(NULLIF(trim(cd.forma_pago),''),'SIN FORMA') AS forma_pago,count(*)::int AS count,
      COALESCE(sum(cd.monto_ingreso_efectivo+cd.monto_ingreso_tarjeta+cd.monto_ingreso_transferencia),0) AS amount
      FROM caja_cierre_detalle cd WHERE cd.fecha_creado >= $1::date AND cd.fecha_creado < $2::date + INTERVAL '1 day' AND COALESCE(cd.es_caja,true)
      GROUP BY COALESCE(NULLIF(trim(cd.forma_pago),''),'SIN FORMA') ORDER BY amount DESC`, values),
    report.query(`WITH room_sales AS (
      SELECT v.fk_idhabitacion_recepcion AS reception_id,
        sum(COALESCE(v.monto_minimo,0)+COALESCE(v.monto_adicional,0)*COALESCE(v.cant_adicional,0)+COALESCE(v.monto_consumo,0)-COALESCE(v.monto_descuento,0)) AS amount
      FROM venta v JOIN habitacion_recepcion hr ON hr.idhabitacion_recepcion=v.fk_idhabitacion_recepcion
      WHERE ${occupancyWhere} AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO')
      GROUP BY v.fk_idhabitacion_recepcion
    ) SELECT hr.nro_habitacion AS room,count(*)::int AS occupations,COALESCE(sum(rs.amount),0) AS amount
      FROM habitacion_recepcion hr LEFT JOIN room_sales rs ON rs.reception_id=hr.idhabitacion_recepcion
      WHERE ${occupancyWhere} GROUP BY hr.nro_habitacion ORDER BY occupations DESC,amount DESC LIMIT 20`, values),
    report.query(`SELECT round(COALESCE(avg(extract(epoch FROM (COALESCE(hr.fec_ocupado_fin,now())-hr.fec_ocupado_inicio))/3600),0)::numeric,2) AS occupied,
      round(COALESCE((SELECT avg(extract(epoch FROM (COALESCE(x.fec_sucio_fin,now())-x.fec_sucio_inicio))/3600) FROM habitacion_recepcion x WHERE x.fec_sucio_inicio >= $1::date AND x.fec_sucio_inicio < $2::date + INTERVAL '1 day'),0)::numeric,2) AS dirty,
      round(COALESCE((SELECT avg(extract(epoch FROM (COALESCE(x.fec_limpieza_fin,now())-x.fec_limpieza_inicio))/3600) FROM habitacion_recepcion x WHERE x.fec_limpieza_inicio >= $1::date AND x.fec_limpieza_inicio < $2::date + INTERVAL '1 day'),0)::numeric,2) AS cleaning
      FROM habitacion_recepcion hr WHERE ${occupancyWhere}`, values),
    report.query(`SELECT extract(isodow FROM hr.fec_ocupado_inicio)::int AS weekday,extract(hour FROM hr.fec_ocupado_inicio)::int AS hour,count(*)::int AS count
      FROM habitacion_recepcion hr WHERE ${occupancyWhere} GROUP BY weekday,hour ORDER BY weekday,hour`, values),
    report.query(`SELECT COALESCE(NULLIF(trim(p.nombre),''),vi.descripcion,'Sin producto') AS product,
      COALESCE(NULLIF(trim(pc.nombre),''),'Sin categoría') AS category,sum(vi.cantidad) AS quantity,
      sum(vi.cantidad*vi.precio_venta) AS amount
      FROM venta_item vi JOIN venta v ON v.idventa=vi.fk_idventa LEFT JOIN producto p ON p.idproducto=vi.fk_idproducto
      LEFT JOIN producto_categoria pc ON pc.idproducto_categoria=p.fk_idproducto_categoria
      WHERE ${salesWhere} AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO') AND COALESCE(vi.tipo_item,'') NOT IN ('CANCELADO','ANULADO')
      GROUP BY product,category ORDER BY quantity DESC,amount DESC LIMIT 20`, values),
    report.query(`SELECT COALESCE(NULLIF(trim(p.nombre),''),vi.descripcion,'Sin producto') AS product,
      COALESCE(NULLIF(trim(pc.nombre),''),'Sin categoría') AS category,sum(vi.cantidad) AS quantity,
      sum(vi.cantidad*vi.precio_venta) AS amount
      FROM venta_item vi JOIN venta v ON v.idventa=vi.fk_idventa LEFT JOIN producto p ON p.idproducto=vi.fk_idproducto
      LEFT JOIN producto_categoria pc ON pc.idproducto_categoria=p.fk_idproducto_categoria
      WHERE ${salesWhere} AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO') AND COALESCE(vi.tipo_item,'') NOT IN ('CANCELADO','ANULADO')
      GROUP BY product,category ORDER BY amount DESC,quantity DESC LIMIT 20`, values),
    report.query(`SELECT COALESCE(NULLIF(trim(pc.nombre),''),'Sin categoría') AS category,sum(vi.cantidad) AS quantity,
      sum(vi.cantidad*vi.precio_venta) AS amount
      FROM venta_item vi JOIN venta v ON v.idventa=vi.fk_idventa LEFT JOIN producto p ON p.idproducto=vi.fk_idproducto
      LEFT JOIN producto_categoria pc ON pc.idproducto_categoria=p.fk_idproducto_categoria
      WHERE ${salesWhere} AND COALESCE(v.estado,'') NOT IN ('CANCELADO','ANULADO') AND COALESCE(vi.tipo_item,'') NOT IN ('CANCELADO','ANULADO')
      GROUP BY category ORDER BY amount DESC LIMIT 20`, values),
    report.query(`SELECT COALESCE(v.estado,'SIN ESTADO') AS state,count(*)::int AS count FROM venta v WHERE ${salesWhere} GROUP BY v.estado ORDER BY count DESC`, values)
  ]);
  const occupationCount = daily.rows.reduce((sum, row) => sum + Number(row.occupations || 0), 0);
  res.json({ filters: { from, to }, generatedAt: new Date().toISOString(), totals: { ...totals.rows[0], occupations: occupationCount }, daily: daily.rows,
    payments: { methods: [{ method: 'EFECTIVO', amount: payments.rows[0].efectivo }, { method: 'TARJETA', amount: payments.rows[0].tarjeta }, { method: 'TRANSFERENCIA', amount: payments.rows[0].transferencia }], forms: paymentForms.rows },
    rooms: rooms.rows, durations: durations.rows[0], heatmap: heatmap.rows, products: products.rows, productsByAmount: productsByAmount.rows, categories: categories.rows, states: states.rows });
}));
app.get('/api/cashier-users', wrap(async (req, res) => {
  const search = safeString(req.query.search);
  const result = await report.query(`SELECT u.idusuario AS id,u.nombre FROM usuario u
    WHERE ($1='' OR u.nombre ILIKE '%'||$1||'%') ORDER BY u.nombre LIMIT 200`, [search]);
  res.json({ rows: result.rows });
}));

const reportQuery = `WITH selected AS (
  SELECT cc.idcaja_cierre AS id, cc.fecha_inicio, cc.fecha_fin, cc.estado, cc.fk_idusuario, u.nombre AS usuario
  FROM caja_cierre cc LEFT JOIN usuario u ON u.idusuario=cc.fk_idusuario
  WHERE ($1::date IS NULL OR cc.fecha_inicio >= $1::date)
    AND ($2::date IS NULL OR cc.fecha_inicio < $2::date + INTERVAL '1 day')
    AND ($3::int = 0 OR cc.fk_idusuario=$3::int)
    AND ($4::text = '' OR cc.estado=$4::text)
    AND ($5::text = '' OR CASE
      WHEN cc.fecha_inicio::time > TIME '05:00' AND cc.fecha_inicio::time < TIME '07:00' THEN 'manana'
      WHEN (cc.fecha_inicio::time > TIME '13:00' AND cc.fecha_inicio::time < TIME '15:00') OR (cc.fecha_inicio::time > TIME '17:00' AND cc.fecha_inicio::time < TIME '19:00') THEN 'tarde'
      WHEN cc.fecha_inicio::time > TIME '21:00' AND cc.fecha_inicio::time < TIME '23:00' THEN 'noche'
      ELSE 'otro' END = $5::text)
  ORDER BY cc.idcaja_cierre DESC LIMIT $6 OFFSET $7
), totals AS (
  SELECT cci.fk_idcaja_cierre AS id, count(*)::int AS movimientos,
    COALESCE(sum(CASE WHEN (s.estado='CERRADO' AND cd.es_caja) OR (s.estado<>'CERRADO' AND cd.es_cerrado) THEN
      COALESCE(cd.monto_solo_adelanto,0)+COALESCE(cd.monto_ocupa_minimo,0)+COALESCE(cd.monto_ocupa_adicional,0)+COALESCE(cd.monto_ocupa_consumo,0)+COALESCE(cd.monto_interno,0)+COALESCE(cd.monto_garantia,0)-COALESCE(cd.monto_ocupa_descuento,0)-COALESCE(cd.monto_ocupa_adelanto,0)
      ELSE 0 END),0) AS ingreso,
    COALESCE(sum(CASE WHEN cd.es_caja AND (s.estado='CERRADO' OR cd.es_cerrado) THEN
      COALESCE(cd.monto_gasto,0)+COALESCE(cd.monto_compra,0)+COALESCE(cd.monto_vale,0)+COALESCE(cd.monto_liquidacion,0)
      ELSE 0 END),0) AS egreso
  FROM caja_cierre_item cci JOIN selected s ON s.id=cci.fk_idcaja_cierre
  JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=cci.fk_idcaja_cierre_detalle
  GROUP BY cci.fk_idcaja_cierre
)
SELECT s.*, COALESCE(t.movimientos,0) AS movimientos, COALESCE(t.ingreso,0) AS ingreso,
  COALESCE(t.egreso,0) AS egreso, COALESCE(t.ingreso,0)-COALESCE(t.egreso,0) AS saldo
FROM selected s LEFT JOIN totals t ON t.id=s.id ORDER BY s.id DESC`;

app.get('/api/cash', wrap(async (req, res) => {
  const from = safeDate(req.query.from), to = safeDate(req.query.to);
  const user = int(req.query.user), state = safeString(req.query.state).toUpperCase();
  const page = Math.min(int(req.query.page, 1) || 1, 100000);
  const size = Math.min(int(req.query.size, 30) || 30, 100);
  const turn = safeString(req.query.turn).toLowerCase();
  const values = [from, to, user, state, turn, size, (page - 1) * size];
  const result = await report.query(reportQuery, values);
  const count = await report.query(`SELECT count(*)::int AS total FROM caja_cierre cc WHERE ($1::date IS NULL OR cc.fecha_inicio >= $1::date) AND ($2::date IS NULL OR cc.fecha_inicio < $2::date + INTERVAL '1 day') AND ($3::int=0 OR cc.fk_idusuario=$3::int) AND ($4::text='' OR cc.estado=$4::text) AND ($5::text='' OR CASE WHEN cc.fecha_inicio::time > TIME '05:00' AND cc.fecha_inicio::time < TIME '07:00' THEN 'manana' WHEN (cc.fecha_inicio::time > TIME '13:00' AND cc.fecha_inicio::time < TIME '15:00') OR (cc.fecha_inicio::time > TIME '17:00' AND cc.fecha_inicio::time < TIME '19:00') THEN 'tarde' WHEN cc.fecha_inicio::time > TIME '21:00' AND cc.fecha_inicio::time < TIME '23:00' THEN 'noche' ELSE 'otro' END=$5::text)`, values.slice(0, 5));
  res.json({ rows: result.rows, total: count.rows[0].total, page, size });
}));
app.get('/api/cash/:id(\\d+)', wrap(async (req, res) => {
  const id = int(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido.' }); return; }
  const header = await report.query(`SELECT cc.idcaja_cierre AS id,cc.fecha_inicio,cc.fecha_fin,cc.estado,cc.creado_por,u.nombre AS usuario FROM caja_cierre cc LEFT JOIN usuario u ON u.idusuario=cc.fk_idusuario WHERE cc.idcaja_cierre=$1`, [id]);
  if (!header.rows.length) { res.status(404).json({ error: 'Cierre no encontrado.' }); return; }
  const [summary, details, occupancies, consumption, internalSales, expenses, guarantees, cancelled] = await Promise.all([
    report.query(`SELECT
      COALESCE(sum(cd.monto_ocupa_minimo-cd.monto_ocupa_adelanto) FILTER (WHERE cd.es_caja),0) AS minimo,
      COALESCE(sum(cd.monto_ocupa_adicional) FILTER (WHERE cd.es_caja),0) AS adicional,
      COALESCE(sum(cd.monto_ocupa_consumo) FILTER (WHERE cd.es_caja),0) AS consumo,
      COALESCE(sum(cd.monto_ocupa_descuento) FILTER (WHERE cd.es_caja),0) AS descuento,
      COALESCE(sum(cd.monto_solo_adelanto) FILTER (WHERE cd.es_caja),0) AS adelanto,
      COALESCE(sum(cd.monto_interno) FILTER (WHERE cd.es_caja),0) AS interno,
      COALESCE(sum(cd.monto_garantia) FILTER (WHERE cd.es_caja),0) AS garantia,
      COALESCE(sum(COALESCE(cd.monto_solo_adelanto,0)+COALESCE(cd.monto_ocupa_minimo,0)+COALESCE(cd.monto_ocupa_adicional,0)+COALESCE(cd.monto_ocupa_consumo,0)+COALESCE(cd.monto_interno,0)+COALESCE(cd.monto_garantia,0)-COALESCE(cd.monto_ocupa_descuento,0)-COALESCE(cd.monto_ocupa_adelanto,0)) FILTER (WHERE cd.es_caja),0) AS ingreso,
      COALESCE(sum(cd.monto_ingreso_efectivo) FILTER (WHERE cd.es_caja),0) AS efectivo,
      COALESCE(sum(cd.monto_ingreso_tarjeta) FILTER (WHERE cd.es_caja),0) AS tarjeta,
      COALESCE(sum(cd.monto_ingreso_transferencia) FILTER (WHERE cd.es_caja),0) AS transferencia,
      COALESCE(sum(cd.monto_compra) FILTER (WHERE cd.es_caja),0) AS compra,
      COALESCE(sum(cd.monto_vale) FILTER (WHERE cd.es_caja),0) AS vale,
      COALESCE(sum(cd.monto_liquidacion) FILTER (WHERE cd.es_caja),0) AS liquidacion,
      COALESCE(sum(cd.monto_gasto) FILTER (WHERE cd.es_caja),0) AS gasto,
      COALESCE(sum(COALESCE(cd.monto_gasto,0)+COALESCE(cd.monto_compra,0)+COALESCE(cd.monto_vale,0)+COALESCE(cd.monto_liquidacion,0)) FILTER (WHERE cd.es_caja),0) AS egreso,
      COALESCE(sum(cd.monto_apertura_caja) FILTER (WHERE cd.es_caja),0) AS apertura,
      count(*) FILTER (WHERE cd.cerrado_por='DESOCUPADO')::int AS ocupaciones
      FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle WHERE i.fk_idcaja_cierre=$1`, [id]),
    report.query(`SELECT cd.idcaja_cierre_detalle AS id,cd.fecha_creado,cd.descripcion,cd.estado,cd.forma_pago,cd.creado_por,cd.cerrado_por,cd.es_cerrado,cd.es_caja,
    cd.fk_idventa AS venta_id,cd.fk_idgasto AS gasto_id,cd.fk_idcompra AS compra_id,cd.fk_idventa_interno AS venta_interno_id,cd.fk_idgarantia AS garantia_id,
    cd.monto_ocupa_minimo,cd.monto_ocupa_adicional,cd.monto_ocupa_consumo,cd.monto_ocupa_descuento,cd.monto_ocupa_adelanto,cd.monto_solo_adelanto,cd.monto_interno,cd.monto_garantia,cd.monto_gasto,cd.monto_compra,cd.monto_vale,cd.monto_liquidacion,
    v.monto_minimo AS venta_minimo,g.monto_gasto AS gasto_registrado,c.monto_total AS compra_total
    FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
    LEFT JOIN venta v ON v.idventa=cd.fk_idventa AND cd.fk_idventa>0
    LEFT JOIN gasto g ON g.idgasto=cd.fk_idgasto AND cd.fk_idgasto>0
    LEFT JOIN compra c ON c.idcompra=cd.fk_idcompra AND cd.fk_idcompra>0
    WHERE i.fk_idcaja_cierre=$1 ORDER BY cd.fecha_creado,cd.idcaja_cierre_detalle`, [id]),
    report.query(`SELECT cd.idcaja_cierre_detalle AS id,cd.fecha_creado,cd.descripcion,
      COALESCE(cd.monto_solo_adelanto,0)+COALESCE(cd.monto_ocupa_minimo,0)+COALESCE(cd.monto_ocupa_adicional,0)-COALESCE(cd.monto_ocupa_descuento,0)-COALESCE(cd.monto_ocupa_adelanto,0) AS habitacion,
      COALESCE(cd.monto_ocupa_consumo,0)+COALESCE(cd.monto_interno,0) AS consumo,
      COALESCE(cd.monto_solo_adelanto,0)+COALESCE(cd.monto_ocupa_minimo,0)+COALESCE(cd.monto_ocupa_adicional,0)+COALESCE(cd.monto_ocupa_consumo,0)+COALESCE(cd.monto_interno,0)+COALESCE(cd.monto_garantia,0)-COALESCE(cd.monto_ocupa_descuento,0)-COALESCE(cd.monto_ocupa_adelanto,0) AS total
      FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
      WHERE i.fk_idcaja_cierre=$1 AND cd.fk_idventa>0 AND cd.estado<>'CANCELADO' ORDER BY cd.idcaja_cierre_detalle DESC`, [id]),
    report.query(`SELECT vi.descripcion, sum(vi.cantidad) AS cantidad, sum(vi.cantidad*vi.precio_venta) AS subtotal
      FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
      JOIN venta v ON v.idventa=cd.fk_idventa JOIN venta_item vi ON vi.fk_idventa=v.idventa
      WHERE i.fk_idcaja_cierre=$1 AND v.estado='TERMINADO' AND cd.cerrado_por='DESOCUPADO' AND v.monto_consumo>0
      GROUP BY vi.descripcion ORDER BY cantidad DESC,vi.descripcion`, [id]),
    report.query(`SELECT vi.descripcion, sum(vi.cantidad) AS cantidad, sum(vi.cantidad*vi.precio_venta) AS subtotal
      FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
      JOIN venta_interno v ON v.idventa_interno=cd.fk_idventa_interno JOIN venta_item_interno vi ON vi.fk_idventa_interno=v.idventa_interno
      WHERE i.fk_idcaja_cierre=$1 AND v.estado='TERMINADO' AND cd.cerrado_por='VEN_INTERNA' AND v.monto_interno>0
      GROUP BY vi.descripcion ORDER BY cantidad DESC,vi.descripcion`, [id]),
    report.query(`SELECT g.idgasto AS id,g.fecha_creado,gt.nombre AS tipo,g.descripcion,g.monto_gasto AS monto
      FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
      JOIN gasto g ON g.idgasto=cd.fk_idgasto JOIN gasto_tipo gt ON gt.idgasto_tipo=g.fk_idgasto_tipo
      WHERE i.fk_idcaja_cierre=$1 AND cd.es_caja=true ORDER BY g.fecha_creado DESC`, [id]),
    report.query(`SELECT g.idgarantia AS id,g.responsable,g.descripcion_objeto,g.estado,g.monto_garantia AS monto
      FROM caja_cierre_item i JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
      JOIN garantia g ON g.idgarantia=cd.fk_idgarantia WHERE i.fk_idcaja_cierre=$1 ORDER BY g.fecha_creado DESC`, [id]),
    report.query(`SELECT cd.idcaja_cierre_detalle AS id,cd.descripcion FROM caja_cierre_item i
      JOIN caja_cierre_detalle cd ON cd.idcaja_cierre_detalle=i.fk_idcaja_cierre_detalle
      WHERE i.fk_idcaja_cierre=$1 AND cd.fk_idventa>0 AND cd.estado='CANCELADO' ORDER BY cd.idcaja_cierre_detalle DESC`, [id])
  ]);
  const totals = summary.rows[0];
  res.json({ header: header.rows[0], summary: { ...totals, saldo: Number(totals.ingreso)-Number(totals.egreso) }, rows: details.rows,
    sections: { occupancies: occupancies.rows, consumption: consumption.rows, internalSales: internalSales.rows, expenses: expenses.rows, guarantees: guarantees.rows, cancelled: cancelled.rows } });
}));
app.get('/api/cash.csv', wrap(async (req, res) => {
  const values = [safeDate(req.query.from), safeDate(req.query.to), int(req.query.user), safeString(req.query.state).toUpperCase(), safeString(req.query.turn).toLowerCase(), 10000, 0];
  const rows = (await report.query(reportQuery, values)).rows;
  const columns = ['id','fecha_inicio','fecha_fin','estado','usuario','movimientos','ingreso','egreso','saldo'];
  const csv = [columns.join(';'), ...rows.map(row => columns.map(key => `"${String(row[key] ?? '').replaceAll('"','""')}"`).join(';'))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="caja_cierres.csv"'); res.send('\ufeff' + csv);
}));
app.get('/api/health', wrap(async (_req, res) => { await Promise.all([report.query('SELECT 1'), auth.query('SELECT 1')]); res.json({ ok: true }); }));

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '../web');
app.use(express.static(web));
app.get('*', (_req, res) => res.sendFile(path.join(web, 'index.html')));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => { console.error(err); res.status(500).json({ error: 'Error del servidor.' }); });
app.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log('Motel web ready'));
