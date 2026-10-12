import type { Express, Request, Response, NextFunction } from 'express';
import type { Pool, PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    sessionVersion?: number;
    authStartedAt?: number;
    lastActivityAt?: number;
    csrfToken?: string;
  }
}

type WebUser = { user_id: number; username: string; password_hash: string; role: 'admin' | 'consulta'; active: boolean; session_version: number };
const publicOrigin = process.env.PUBLIC_ORIGIN || 'https://163.245.222.236';
const localOrigin = (origin: string | undefined) => process.env.NODE_ENV !== 'production' && !!origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
const authError = 'Usuario o contraseña incorrectos.';
const userSelect = 'SELECT user_id,username,password_hash,role,active,session_version FROM usuario_web';
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const normalizeName = (name: unknown) => typeof name === 'string' ? name.trim().normalize('NFC') : '';
const nameIsValid = (name: string) => name.length >= 1 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name);
const passwordIsValid = (password: unknown) => typeof password === 'string' && Array.from(password).length >= 8 && Buffer.byteLength(password, 'utf8') <= 72;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const regenerate = (req: Request) => new Promise<void>((resolve,reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
const destroy = (req: Request) => new Promise<void>((resolve,reject) => req.session.destroy(e => e ? reject(e) : resolve()));

async function isLimited(auth: Pool, key: string, max: number) {
  const result = await auth.query("SELECT attempts FROM auth_rate_limit WHERE key=$1 AND window_start >= now()-interval '15 minutes'",[sha(key)]);
  return Number(result.rows[0]?.attempts || 0) >= max;
}
async function recordFailure(auth: Pool, key: string) {
  await auth.query(`INSERT INTO auth_rate_limit(key,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET
    attempts=CASE WHEN auth_rate_limit.window_start < now()-interval '15 minutes' THEN 1 ELSE auth_rate_limit.attempts+1 END,
    window_start=CASE WHEN auth_rate_limit.window_start < now()-interval '15 minutes' THEN now() ELSE auth_rate_limit.window_start END`, [sha(key)]);
}
async function audit(client: PoolClient, actor: number, target: number, action: string) {
  await client.query('INSERT INTO web_audit(actor_user_id,target_user_id,action) VALUES($1,$2,$3)',[actor,target,action]);
}
async function currentUser(auth: Pool, req: Request): Promise<WebUser | null> {
  const id = req.session.userId;
  if (!id) return null;
  const now = Date.now();
  if (!req.session.authStartedAt || !req.session.lastActivityAt || now-req.session.authStartedAt > 8*60*60*1000 || now-req.session.lastActivityAt > 30*60*1000) return null;
  const found = await auth.query(`${userSelect} WHERE user_id=$1`,[id]);
  const user = found.rows[0] as WebUser | undefined;
  if (!user?.active || user.session_version !== req.session.sessionVersion) return null;
  req.session.lastActivityAt = now;
  return user;
}
function startSession(req: Request, user: WebUser) {
  req.session.userId = user.user_id;
  req.session.sessionVersion = user.session_version;
  req.session.authStartedAt = Date.now();
  req.session.lastActivityAt = Date.now();
}
function publicUser(user: WebUser) { return { id:user.user_id, username:user.username, role:user.role }; }

export function attachAuth(app: Express, auth: Pool) {
  app.get('/api/csrf', (req,res) => { res.setHeader('Cache-Control','no-store'); req.session.csrfToken ||= randomBytes(32).toString('base64url'); res.json({ token:req.session.csrfToken }); });
  app.use('/api', (req,res,next) => {
    res.setHeader('Cache-Control','no-store');
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && origin !== publicOrigin && !localOrigin(origin)) { res.status(403).json({error:'Solicitud no permitida.'}); return; }
      if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) { res.status(403).json({error:'Actualice la página e intente nuevamente.'}); return; }
    }
    next();
  });
  app.post('/api/login', wrap(async (req,res) => {
    const username = normalizeName(req.body?.username), password = req.body?.password;
    if (!nameIsValid(username) || !passwordIsValid(password)) { res.status(401).json({error:authError}); return; }
    const ip = req.ip || 'unknown';
    const ipKey = `login-ip:${ip}`, userKey = `login-user:${username.toLowerCase()}:${ip}`;
    if (await isLimited(auth,ipKey,40) || await isLimited(auth,userKey,8)) { res.status(429).json({error:'Demasiados intentos. Espere 15 minutos.'}); return; }
    const found = await auth.query(`${userSelect} WHERE lower(username)=lower($1)`,[username]);
    const user = found.rows[0] as WebUser | undefined;
    const dummy = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO9V8n71pdG5sPpFvk8ppxW5fYQy5wdnW';
    const valid = await bcrypt.compare(password,user?.password_hash || dummy);
    if (!user?.active || !valid) { await Promise.all([recordFailure(auth,ipKey),recordFailure(auth,userKey)]); res.status(401).json({error:authError}); return; }
    await regenerate(req);
    startSession(req,user);
    res.json({ user:publicUser(user) });
  }));
  app.post('/api/logout', wrap(async (req,res) => { await destroy(req); res.clearCookie('motel.sid'); res.json({ok:true}); }));
  app.get('/api/me', wrap(async (req,res) => {
    const user = await currentUser(auth,req);
    if (!user) { res.status(401).json({error:'Inicie sesión.'}); return; }
    res.json({ user:publicUser(user) });
  }));
  app.use('/api', (req,res,next) => {
    currentUser(auth,req).then(user => {
      if (!user) { res.status(401).json({error:'Inicie sesión.'}); return; }
      res.locals.webUser = user;
      next();
    }).catch(next);
  });
  app.post('/api/change-password', wrap(async (req,res) => {
    const user = res.locals.webUser as WebUser;
    const oldPassword = req.body?.oldPassword, password = req.body?.password;
    if (typeof oldPassword !== 'string' || !(await bcrypt.compare(oldPassword,user.password_hash))) { res.status(401).json({error:authError}); return; }
    if (!passwordIsValid(password)) { res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres (máximo 72 bytes).'}); return; }
    if (await bcrypt.compare(password,user.password_hash)) { res.status(400).json({error:'La contraseña nueva debe ser diferente.'}); return; }
    const hash = await bcrypt.hash(password,12);
    const changed = await auth.query(`UPDATE usuario_web SET password_hash=$2,must_change_password=false,session_version=session_version+1,updated_at=now()
      WHERE user_id=$1 AND session_version=$3 RETURNING user_id,username,password_hash,role,active,session_version`,[user.user_id,hash,user.session_version]);
    if (!changed.rowCount) { res.status(401).json({error:'Inicie sesión nuevamente.'}); return; }
    await regenerate(req);
    startSession(req,changed.rows[0] as WebUser);
    res.json({user:publicUser(changed.rows[0] as WebUser)});
  }));
  app.get('/api/web-users', wrap(async (_req,res) => {
    if ((res.locals.webUser as WebUser).role !== 'admin') { res.status(403).json({error:'Operación no permitida.'}); return; }
    const found = await auth.query('SELECT user_id AS id,username,role,active,created_at FROM usuario_web ORDER BY user_id');
    res.json({rows:found.rows});
  }));
  app.post('/api/web-users', wrap(async (req,res) => {
    const actor = res.locals.webUser as WebUser;
    if (actor.role !== 'admin') { res.status(403).json({error:'Operación no permitida.'}); return; }
    const username = normalizeName(req.body?.username), role = req.body?.role, password = req.body?.password;
    if (!nameIsValid(username) || !['admin','consulta'].includes(role) || !passwordIsValid(password)) { res.status(400).json({error:'Escriba un usuario y una contraseña de al menos 8 caracteres.'}); return; }
    const hash = await bcrypt.hash(password,12);
    try {
      const client = await auth.connect();
      try {
        await client.query('BEGIN');
        const created = await client.query('INSERT INTO usuario_web(username,password_hash,role,must_change_password) VALUES($1,$2,$3,false) RETURNING user_id',[username,hash,role]);
        const id = Number(created.rows[0].user_id);
        await audit(client,actor.user_id,id,'create');
        await client.query('COMMIT');
        res.status(201).json({id,username,role});
      } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } catch(e) { if ((e as {code?:string}).code === '23505') { res.status(409).json({error:'Ese usuario ya existe.'}); return; } throw e; }
  }));
  app.patch('/api/web-users/:id(\\d+)', wrap(async (req,res) => {
    const actor = res.locals.webUser as WebUser;
    if (actor.role !== 'admin') { res.status(403).json({error:'Operación no permitida.'}); return; }
    const id = Number(req.params.id), active = req.body?.active, role = req.body?.role;
    if ((active !== undefined && typeof active !== 'boolean') || (role !== undefined && !['admin','consulta'].includes(role)) || (active === undefined && role === undefined)) { res.status(400).json({error:'Cambio inválido.'}); return; }
    const client = await auth.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(291847)');
      const found = await client.query('SELECT role,active FROM usuario_web WHERE user_id=$1 FOR UPDATE',[id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); res.status(404).json({error:'Usuario no encontrado.'}); return; }
      const nextActive = active === undefined ? found.rows[0].active : active, nextRole = role || found.rows[0].role;
      if (id === actor.user_id && (!nextActive || nextRole !== 'admin')) { await client.query('ROLLBACK'); res.status(400).json({error:'No puede quitar su propio acceso de administrador.'}); return; }
      if (found.rows[0].active && found.rows[0].role === 'admin' && (!nextActive || nextRole !== 'admin')) {
        const count = await client.query("SELECT count(*)::int AS n FROM usuario_web WHERE active AND role='admin'");
        if (count.rows[0].n <= 1) { await client.query('ROLLBACK'); res.status(400).json({error:'Debe quedar un administrador activo.'}); return; }
      }
      await client.query('UPDATE usuario_web SET active=$2,role=$3,session_version=session_version+1,updated_at=now() WHERE user_id=$1',[id,nextActive,nextRole]);
      await audit(client,actor.user_id,id,'update');
      await client.query('COMMIT');
      res.json({ok:true});
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
  app.post('/api/web-users/:id(\\d+)/reset-password', wrap(async (req,res) => {
    const actor = res.locals.webUser as WebUser;
    if (actor.role !== 'admin') { res.status(403).json({error:'Operación no permitida.'}); return; }
    const id = Number(req.params.id), password = req.body?.password;
    if (id === actor.user_id) { res.status(400).json({error:'Cambie su propia contraseña desde su cuenta.'}); return; }
    if (!passwordIsValid(password)) { res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres (máximo 72 bytes).'}); return; }
    const hash = await bcrypt.hash(password,12);
    const client = await auth.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query('UPDATE usuario_web SET password_hash=$2,must_change_password=false,session_version=session_version+1,updated_at=now() WHERE user_id=$1 RETURNING user_id',[id,hash]);
      if (!changed.rowCount) { await client.query('ROLLBACK'); res.status(404).json({error:'Usuario no encontrado.'}); return; }
      await audit(client,actor.user_id,id,'reset-password');
      await client.query('COMMIT');
      res.json({ok:true});
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
}
