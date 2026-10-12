import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

const authUrl = process.env.AUTH_DATABASE_URL;
if (!authUrl) throw new Error('AUTH_DATABASE_URL missing');
const pool = new pg.Pool({ connectionString: authUrl });
const password = randomBytes(24).toString('base64url');
const hash = await bcrypt.hash(password, 12);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(291848)');
  const count = await client.query('SELECT count(*)::int AS n FROM usuario_web');
  if (count.rows[0].n !== 0) throw new Error('Bootstrap refused: usuario_web is not empty');
  await client.query("INSERT INTO usuario_web(username,password_hash,role,active,must_change_password) VALUES('admin',$1,'admin',true,false)", [hash]);
  await client.query('COMMIT');
  process.stdout.write(`Usuario: admin\nClave inicial (mostrar una vez): ${password}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
