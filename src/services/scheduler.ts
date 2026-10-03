import { config } from '../config.js';
import { query } from '../db/pool.js';
import { runScan } from './scan.js';
import { logError, logInfo } from '../utils/logger.js';

let timer: NodeJS.Timeout | null = null;
let stopped = true;
let running = false;

export function cadenceToMs(cadence: string): number | null {
  if (!cadence || cadence === 'none') return null;
  const ms = (config.sync.cadenceMs as Record<string, number>)[cadence];
  return typeof ms === 'number' && ms > 0 ? ms : null;
}

export function isCadenceAllowed(cadence: string): boolean {
  return config.sync.allowedCadences.includes(cadence);
}

export async function getOrCreateSyncConfig(userId: string): Promise<{ cadence: string; next_run_at: string | null; last_run_at: string | null }> {
  const { rows } = await query<{ cadence: string; next_run_at: string | null; last_run_at: string | null }>(
    `SELECT cadence, next_run_at, last_run_at FROM sync_configs WHERE user_id=$1`,
    [userId],
  );
  if (rows[0]) return rows[0];
  const created = await query<{ cadence: string; next_run_at: string | null; last_run_at: string | null }>(
    `INSERT INTO sync_configs (user_id, cadence) VALUES ($1,'none') ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING cadence, next_run_at, last_run_at`,
    [userId],
  );
  return created.rows[0];
}

export async function setCadence(userId: string, cadence: string): Promise<{ cadence: string; next_run_at: string | null }> {
  if (!isCadenceAllowed(cadence)) throw new Error(`Invalid cadence. Allowed: ${config.sync.allowedCadences.join(', ')}`);
  const ms = cadenceToMs(cadence);
  const nextRun = ms ? new Date(Date.now() + ms).toISOString() : null;
  const { rows } = await query<{ cadence: string; next_run_at: string | null }>(
    `INSERT INTO sync_configs (user_id, cadence, next_run_at, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id) DO UPDATE SET cadence=EXCLUDED.cadence, next_run_at=EXCLUDED.next_run_at, last_error=NULL, updated_at=NOW()
     RETURNING cadence, next_run_at`,
    [userId, cadence, nextRun],
  );
  logInfo('Sync cadence updated', { userId, cadence, nextRun });
  return rows[0];
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { rows } = await query<{ user_id: string; cadence: string }>(
      `SELECT user_id, cadence FROM sync_configs WHERE cadence <> 'none' AND next_run_at IS NOT NULL AND next_run_at <= NOW() LIMIT 20`,
    );
    for (const row of rows) {
      try {
        logInfo('Running scheduled sync', { userId: row.user_id, cadence: row.cadence });
        await runScan(row.user_id, { trigger: `schedule:${row.cadence}` });
        const ms = cadenceToMs(row.cadence);
        const next = ms ? new Date(Date.now() + ms).toISOString() : null;
        await query(`UPDATE sync_configs SET last_run_at=NOW(), next_run_at=$1, last_error=NULL, updated_at=NOW() WHERE user_id=$2`, [next, row.user_id]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError('Scheduled sync failed', { userId: row.user_id, error: message });
        const ms = cadenceToMs(row.cadence);
        const next = ms ? new Date(Date.now() + ms).toISOString() : null;
        await query(`UPDATE sync_configs SET next_run_at=$1, last_error=$2, updated_at=NOW() WHERE user_id=$3`, [next, message, row.user_id]);
      }
    }
  } catch (err) {
    logError('Scheduler tick failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    if (!stopped) timer = setTimeout(() => void tick(), config.sync.pollIntervalMs);
  }
}

export function startScheduler(): void {
  if (!stopped) return;
  stopped = false;
  timer = setTimeout(() => void tick(), 2000);
  logInfo('Scheduler started', { pollMs: config.sync.pollIntervalMs });
}

export async function stopScheduler(): Promise<void> {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  logInfo('Scheduler stopped');
}
