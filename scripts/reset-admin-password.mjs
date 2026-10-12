import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

if (process.argv[2] !== '--confirm-admin-reset') throw new Error('Pass --confirm-admin-reset to reset admin');
if (!process.env.AUTH_DATABASE_URL) throw new Error('AUTH_DATABASE_URL missing');

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const password = Array.from({length:16},() => alphabet[randomInt(alphabet.length)]).join('');
const hash = await bcrypt.hash(password,12);
const pool = new pg.Pool({connectionString:process.env.AUTH_DATABASE_URL});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const found = await client.query("SELECT user_id,role,active FROM usuario_web WHERE lower(username)='admin' FOR UPDATE");
  if (found.rowCount !== 1 || found.rows[0].role !== 'admin' || !found.rows[0].active) throw new Error('Active admin account not found uniquely');
  const id = found.rows[0].user_id;
  await client.query('UPDATE usuario_web SET password_hash=$2,must_change_password=false,session_version=session_version+1,updated_at=now() WHERE user_id=$1',[id,hash]);
  await client.query("INSERT INTO web_audit(actor_user_id,target_user_id,action) VALUES($1,$1,'admin-password-reset')",[id]);
  await client.query('COMMIT');
  process.stdout.write(`admin-password=${password}\n`);
} catch(e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
