import { Pool } from 'pg';
import { config } from '../config.js';

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.maxPool,
  idleTimeoutMillis: config.db.idleTimeoutMs,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', message: 'Unexpected pg pool error', error: err.message }));
});

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
  const result = await pool.query(text, params as unknown[]);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

export async function closePool(): Promise<void> {
  await pool.end();
}
