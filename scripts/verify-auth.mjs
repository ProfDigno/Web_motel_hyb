import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.AUTH_DATABASE_URL });
const origin = process.env.PUBLIC_ORIGIN || 'https://163.245.222.236';
const suffix = randomBytes(4).toString('hex');
const names = [`test_consulta_${suffix}`, `test_admin_${suffix}`, `Prueba Web ${suffix}`];
const password = 'Abcd1234';
const newPassword = 'Nueva1234';
const results = [];

function browser() {
  let cookie = '';
  return async (path, method = 'GET', data) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') {
      const csrf = await fetch(origin + '/api/csrf', { headers });
      const setCookie = csrf.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      headers.Cookie = cookie;
      headers['X-CSRF-Token'] = (await csrf.json()).token;
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(origin + path, { method, headers, body: data ? JSON.stringify(data) : undefined });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
}
function expect(response, status, description) {
  if (response.status !== status) throw new Error(`${description}: HTTP ${response.status}, expected ${status}`);
  results.push(description);
  return response.body;
}

try {
  const hash = await bcrypt.hash(password, 12);
  for (const [i,name] of names.slice(0,2).entries()) await pool.query('INSERT INTO usuario_web(username,password_hash,role,must_change_password) VALUES($1,$2,$3,false)',[name,hash,i?'admin':'consulta']);
  const viewer = browser();
  expect(await viewer('/api/cash'),401,'informes protegidos');
  expect(await viewer('/api/dashboard'),401,'dashboard protegido');
  const noCsrf = await fetch(origin + '/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:names[0],password})});
  if (noCsrf.status !== 403) throw new Error('Login sin CSRF no rechazado');
  results.push('protección CSRF');
  const viewerLogin = expect(await viewer('/api/login','POST',{username:names[0],password}),200,'login con ocho caracteres');
  if (viewerLogin.stage || viewerLogin.user.role !== 'consulta') throw new Error('El login solicitó un paso adicional');
  expect(await viewer('/api/me'),200,'sesión directa sin cambio obligatorio');
  expect(await viewer('/api/web-users'),403,'consulta sin administración');
  const cash = expect(await viewer('/api/cash?page=1'),200,'listado de cierres');
  if (!cash.rows?.length) throw new Error('Listado de cierres vacío');
  expect(await viewer('/api/cash.csv'),200,'exportación CSV');
  const sample = expect(await viewer('/api/cash/3938'),200,'detalle de cierre');
  if (Number(sample.summary.ingreso)!==2356000 || Number(sample.summary.egreso)!==5000 || Number(sample.summary.saldo)!==2351000) throw new Error('Importes de caja 3938 distintos del ticket');
  expect(await viewer('/api/status'),200,'hora de sincronización');
  const occupancy = expect(await viewer('/api/occupancy'),200,'tablero de ocupación');
  if (occupancy.rows?.length !== 26 || !occupancy.syncedAt) throw new Error('El tablero no contiene las 26 habitaciones sincronizadas');
  if (occupancy.rows.some(room => !/^#[0-9a-f]{6}$/i.test(room.background_color) || !/^#[0-9a-f]{6}$/i.test(room.text_color))) throw new Error('El tablero devolvió colores no válidos');
  const dashboard = expect(await viewer('/api/dashboard?from=2026-10-01&to=2026-10-10'),200,'dashboard de ventas y ocupación');
  if (!dashboard.daily || !dashboard.payments || !dashboard.products || !dashboard.productsByAmount || !dashboard.heatmap || !dashboard.states) throw new Error('El dashboard no devolvió todas sus secciones');
  if (dashboard.filters.from !== '2026-10-01' || dashboard.filters.to !== '2026-10-10') throw new Error('El dashboard no respetó el rango');
  if (dashboard.daily.reduce((sum, row) => sum + Number(row.occupations), 0) !== Number(dashboard.totals.occupations)) throw new Error('Las ocupaciones diarias no coinciden con el total');
  if (dashboard.daily.reduce((sum, row) => sum + Number(row.total), 0) !== Number(dashboard.totals.total)) throw new Error('Las ventas diarias no coinciden con el total');
  if (dashboard.productsByAmount.some((row,index,rows) => index && Number(row.amount) > Number(rows[index-1].amount))) throw new Error('Los productos por monto están fuera de orden');
  results.push('coherencia de totales y ranking de productos');
  expect(await viewer('/api/dashboard?from=2026-02-30&to=2026-10-10'),400,'fecha inexistente rechazada');
  expect(await viewer('/api/dashboard?from=ayer&to=2026-10-10'),400,'fecha mal formada rechazada');
  expect(await viewer('/api/dashboard?from=2026-10-10&to=2024-01-01'),400,'rango de dashboard invertido');
  expect(await viewer('/api/dashboard?from=2020-01-01&to=2026-10-10'),400,'rango de dashboard demasiado extenso');
  const admin = browser();
  const adminLogin = expect(await admin('/api/login','POST',{username:names[1],password}),200,'login admin sin autenticador');
  if (adminLogin.stage || adminLogin.user.role !== 'admin') throw new Error('El administrador recibió un paso adicional');
  expect(await admin('/api/web-users'),200,'administración disponible');
  expect(await admin('/api/web-users','POST',{username:names[2],role:'consulta',password}),201,'crear usuario de texto con clave fija');
  const created = browser();
  expect(await created('/api/login','POST',{username:names[2],password}),200,'nuevo usuario ingresa directamente');
  const createdId = (await pool.query('SELECT user_id FROM usuario_web WHERE username=$1',[names[2]])).rows[0].user_id;
  expect(await admin(`/api/web-users/${createdId}`,'PATCH',{active:false}),200,'desactivar cuenta');
  expect(await created('/api/cash'),401,'sesión revocada al desactivar');
  expect(await created('/api/login','POST',{username:names[2],password}),401,'cuenta inactiva rechazada');
  expect(await admin(`/api/web-users/${createdId}`,'PATCH',{active:true}),200,'reactivar cuenta');
  expect(await admin(`/api/web-users/${createdId}/reset-password`,'POST',{password:newPassword}),200,'cambiar clave desde administración');
  expect(await created('/api/login','POST',{username:names[2],password}),401,'contraseña anterior rechazada');
  expect(await created('/api/login','POST',{username:names[2],password:newPassword}),200,'contraseña nueva funciona sin cambio obligatorio');
  expect(await viewer('/api/change-password','POST',{oldPassword:password,password:newPassword}),200,'cambio voluntario de contraseña');
  const viewerSecond = browser();
  expect(await viewerSecond('/api/login','POST',{username:names[0],password:newPassword}),200,'nueva contraseña personal funciona');
  const adminId = (await pool.query('SELECT user_id FROM usuario_web WHERE username=$1',[names[1]])).rows[0].user_id;
  expect(await admin(`/api/web-users/${adminId}`,'PATCH',{active:false}),400,'administrador no puede desactivarse a sí mismo');
  console.log(`Verificaciones correctas: ${results.length}`);
  for (const result of results) console.log(`- ${result}`);
} finally {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM web_audit WHERE actor_user_id IN (SELECT user_id FROM usuario_web WHERE username = ANY($1::text[])) OR target_user_id IN (SELECT user_id FROM usuario_web WHERE username = ANY($1::text[]))',[names]);
    await client.query('DELETE FROM usuario_web WHERE username = ANY($1::text[])',[names]);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await pool.end();
}
