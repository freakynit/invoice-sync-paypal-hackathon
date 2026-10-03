import { pool } from './pool.js';
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007, MIGRATION_008, MIGRATION_009 } from './migrations.js';
import { logInfo } from '../utils/logger.js';

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION_001);
    await client.query(MIGRATION_002);
    await client.query(MIGRATION_003);
    await client.query(MIGRATION_004);
    await client.query(MIGRATION_005);
    await client.query(MIGRATION_006);
    await client.query(MIGRATION_007);
    await client.query(MIGRATION_008);
    await client.query(MIGRATION_009);
    await client.query('COMMIT');
    logInfo('Migrations applied (001_init, 002_clerk, 003_paypal_login, 004_drive_folders, 005_scan_progress, 006_matching_cache, 007_razorpay, 008_reliability, 009_webhooks_paynow — idempotent)');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}
