import { config } from '../config.js';
import { query } from '../db/pool.js';
import { downloadDriveFile, getConnection, listSelectedFolderFiles, isSupportedInvoiceType } from './drive.js';
import { extractInvoice, limitConcurrency } from './extractor.js';
import { syncPaypalTransactions } from './paypal.js';
import { syncRazorpayPayments } from './razorpay.js';
import { recomputeMatches } from './matching.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { sendScanReportEmail } from './email.js';

export interface ScanOptions {
  trigger: string;
  forceRescanFileIds?: string[];
  maxFiles?: number;
}

interface ScanCounters {
  filesSeen: number;
  filesNew: number;
  filesRescanned: number;
  transactionsSynced: number;
  matchesCreated: number;
}

export interface ScanProgress {
  runId: string;
  stage: string;
  total: number;
  processed: number;
  filesNew: number;
  filesRescanned: number;
  currentFile: string | null;
  cancelRequested: boolean;
  startedAt: string;
}

const runningScans = new Set<string>();
const cancelRequested = new Set<string>();
const scanProgress = new Map<string, ScanProgress>();

export function isScanRunning(userId: string): boolean {
  return runningScans.has(userId);
}

export function getScanProgress(userId: string): ScanProgress | null {
  return scanProgress.get(userId) ?? null;
}

export function isCancelRequested(userId: string): boolean {
  return cancelRequested.has(userId);
}

class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled by user');
    this.name = 'ScanCancelledError';
  }
}

function throwIfCancelled(userId: string): void {
  if (cancelRequested.has(userId)) throw new ScanCancelledError();
}

export async function requestScanCancel(userId: string): Promise<boolean> {
  if (!runningScans.has(userId)) return false;
  cancelRequested.add(userId);
  const progress = scanProgress.get(userId);
  if (progress) {
    progress.cancelRequested = true;
    if (progress.runId) {
      await query(`UPDATE scan_runs SET cancel_requested=TRUE, current_stage='cancelling', updated_at=NOW() WHERE id=$1`, [
        progress.runId,
      ]).catch(() => {});
    }
  }
  logInfo('Scan cancel requested', { userId, runId: progress?.runId });
  return true;
}

async function createScanRun(userId: string, trigger: string, folderId: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO scan_runs (user_id, trigger, status, drive_folder_id, current_stage, cancel_requested) VALUES ($1,$2,'running',$3,'starting',FALSE) RETURNING id`,
    [userId, trigger, folderId],
  );
  return rows[0].id;
}

async function updateScanRunProgress(
  runId: string,
  fields: { total?: number; processed?: number; stage?: string; currentFile?: string | null; filesNew?: number; filesRescanned?: number },
): Promise<void> {
  const sets: string[] = ['updated_at=NOW()'];
  const vals: unknown[] = [];
  if (fields.total !== undefined) {
    vals.push(fields.total);
    sets.push(`files_total=$${vals.length}, files_seen=$${vals.length}`);
  }
  if (fields.processed !== undefined) {
    vals.push(fields.processed);
    sets.push(`files_processed=$${vals.length}`);
  }
  if (fields.stage !== undefined) {
    vals.push(fields.stage);
    sets.push(`current_stage=$${vals.length}`);
  }
  if (fields.currentFile !== undefined) {
    vals.push(fields.currentFile);
    sets.push(`current_file=$${vals.length}`);
  }
  if (fields.filesNew !== undefined) {
    vals.push(fields.filesNew);
    sets.push(`files_new=$${vals.length}`);
  }
  if (fields.filesRescanned !== undefined) {
    vals.push(fields.filesRescanned);
    sets.push(`files_rescanned=$${vals.length}`);
  }
  if (!vals.length) return;
  vals.push(runId);
  await query(`UPDATE scan_runs SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals).catch((err) => {
    logWarn('Failed to update scan progress', { error: err instanceof Error ? err.message : String(err) });
  });
}

async function finishScanRun(runId: string, status: string, counters: Partial<ScanCounters>, error?: string): Promise<void> {
  await query(
    `UPDATE scan_runs SET status=$1, files_seen=$2, files_total=GREATEST(files_total,$2), files_processed=GREATEST(files_processed,$9), files_new=$3, files_rescanned=$4, transactions_synced=$5, matches_created=$6, error=$7, finished_at=NOW(), updated_at=NOW(), current_stage=$10 WHERE id=$8`,
    [
      status,
      counters.filesSeen ?? 0,
      counters.filesNew ?? 0,
      counters.filesRescanned ?? 0,
      counters.transactionsSynced ?? 0,
      counters.matchesCreated ?? 0,
      error ?? null,
      runId,
      counters.filesSeen ?? 0,
      status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'done',
    ],
  );
}

async function processOneInvoiceFile(
  userId: string,
  file: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string },
  force: boolean,
): Promise<'skipped' | 'new' | 'rescan'> {
  const { rows } = await query<{ id: string; drive_modified_time: string | Date | null }>(
    `SELECT id, drive_modified_time FROM invoices WHERE user_id=$1 AND drive_file_id=$2`,
    [userId, file.id],
  );
  const existing = rows[0];
  const modifiedTime = file.modifiedTime ? new Date(file.modifiedTime).toISOString() : null;

  const unchanged = existing && (existing.drive_modified_time === null && modifiedTime === null ||
    existing.drive_modified_time !== null && modifiedTime !== null &&
    new Date(existing.drive_modified_time).getTime() === new Date(modifiedTime).getTime());
  if (existing && !force && unchanged) return 'skipped';

  const { bytes, mimeType } = await downloadDriveFile(userId, file.id);
  throwIfCancelled(userId);
  const { extracted, rawText } = await extractInvoice(bytes, mimeType, file.name);
  throwIfCancelled(userId);

  await query(
    `INSERT INTO invoices
      (user_id, drive_file_id, drive_file_name, mime_type, drive_modified_time, drive_web_view_link, raw_text, extracted_json,
       invoice_number, vendor_name, amount, currency, invoice_date, due_date, payer_email, status, last_error, last_scanned_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'extracted',NULL,NOW(),NOW())
     ON CONFLICT (user_id, drive_file_id) DO UPDATE SET
       drive_file_name=EXCLUDED.drive_file_name, mime_type=EXCLUDED.mime_type, drive_modified_time=EXCLUDED.drive_modified_time,
       drive_web_view_link=EXCLUDED.drive_web_view_link, raw_text=EXCLUDED.raw_text, extracted_json=EXCLUDED.extracted_json,
       invoice_number=EXCLUDED.invoice_number, vendor_name=EXCLUDED.vendor_name, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       invoice_date=EXCLUDED.invoice_date, due_date=EXCLUDED.due_date, payer_email=EXCLUDED.payer_email,
       status='extracted', last_error=NULL, last_scanned_at=NOW(), updated_at=NOW()`,
    [
      userId,
      file.id,
      file.name,
      mimeType,
      modifiedTime,
      file.webViewLink ?? null,
      rawText || null,
      JSON.stringify(extracted),
      extracted.invoice_number,
      extracted.vendor,
      extracted.amount,
      extracted.currency,
      extracted.invoice_date,
      extracted.due_date,
      extracted.payer_email,
    ],
  );

  return existing ? 'rescan' : 'new';
}

export async function runScan(userId: string, options: ScanOptions): Promise<{ runId: string; counters: ScanCounters }> {
  if (runningScans.has(userId)) throw new Error('A scan is already running for this account. Please wait.');
  runningScans.add(userId);
  cancelRequested.delete(userId);

  const counters: ScanCounters = { filesSeen: 0, filesNew: 0, filesRescanned: 0, transactionsSynced: 0, matchesCreated: 0 };
  let runId: string | undefined;
  const startedAt = new Date().toISOString();
  try {
    const { isDemoUser } = await import('./demo.js');
    const demo = await isDemoUser(userId).catch(() => false);
    if (demo) {
      // Demo scans skip Drive/PayPal entirely: re-score the seeded dataset instantly.
      runId = await createScanRun(userId, options.trigger, 'demo-root');
      scanProgress.set(userId, { runId, stage: 'matching', total: 1, processed: 0, filesNew: 0, filesRescanned: 0, currentFile: 'Demo dataset', cancelRequested: false, startedAt });
      await updateScanRunProgress(runId, { total: 1, processed: 0, stage: 'matching', currentFile: 'Demo dataset' });
      throwIfCancelled(userId);
      const { rows: invRows } = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM invoices WHERE user_id=$1`, [userId]);
      counters.filesSeen = Number(invRows[0].count);
      const matchStats = await recomputeMatches(userId, runId);
      counters.matchesCreated = matchStats.created;
      await updateScanRunProgress(runId, { processed: 1, currentFile: null });
      await finishScanRun(runId, 'success', counters);
      logInfo('Demo scan finished', { userId, runId, ...counters });
      const { fireScanCompleteWebhook } = await import('./webhooks.js');
      await fireScanCompleteWebhook(userId, {
        runId, trigger: options.trigger, status: 'success',
        filesNew: counters.filesNew, filesRescanned: counters.filesRescanned, transactionsSynced: 0,
        matched: matchStats.matched, needsReview: matchStats.review, unmatched: matchStats.unmatched, dashboardUrl: `${config.app.publicBaseUrl}/dashboard`,
      });
      return { runId, counters };
    }
    const conn = await getConnection(userId);
    const folders = conn?.folders ?? [];
    runId = await createScanRun(userId, options.trigger, folders[0]?.id ?? null);
    scanProgress.set(userId, {
      runId,
      stage: 'listing',
      total: 0,
      processed: 0,
      filesNew: 0,
      filesRescanned: 0,
      currentFile: null,
      cancelRequested: false,
      startedAt,
    });
    if (!folders.length) throw new Error('No Drive folders selected. Choose folders in Dashboard → Google Drive first.');

    await updateScanRunProgress(runId, { stage: 'listing' });
    throwIfCancelled(userId);

    const files = await listSelectedFolderFiles(userId, folders, options.maxFiles ?? 200);
    counters.filesSeen = files.length;

    const forceSet = new Set(options.forceRescanFileIds ?? []);
    const supported = files.filter((f) => isSupportedInvoiceType(f.mimeType));

    const progress = scanProgress.get(userId);
    if (progress) {
      progress.total = supported.length;
      progress.stage = 'extracting';
    }
    await updateScanRunProgress(runId, { total: supported.length, processed: 0, stage: 'extracting' });
    throwIfCancelled(userId);

    const runLimited = limitConcurrency();
    let processed = 0;
    const bumpProgress = async (fileName: string | null) => {
      processed++;
      const p = scanProgress.get(userId);
      if (p) {
        p.processed = processed;
        p.filesNew = counters.filesNew;
        p.filesRescanned = counters.filesRescanned;
        p.currentFile = fileName;
      }
      // Persist every file so the Scans page + polling stay live (≤200 writes per scan).
      await updateScanRunProgress(runId!, {
        processed,
        filesNew: counters.filesNew,
        filesRescanned: counters.filesRescanned,
        currentFile: fileName,
      });
    };

    const results = await Promise.allSettled(
      supported.map((file) =>
        runLimited(async () => {
          if (cancelRequested.has(userId)) throw new ScanCancelledError();
          const p = scanProgress.get(userId);
          if (p) p.currentFile = file.name;
          try {
            const force = forceSet.has(file.id);
            const outcome = await processOneInvoiceFile(userId, file, force);
            if (outcome === 'new') counters.filesNew++;
            if (outcome === 'rescan') counters.filesRescanned++;
            return outcome;
          } finally {
            await bumpProgress(file.name);
          }
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        if (r.reason instanceof ScanCancelledError) throw r.reason;
        logWarn('Invoice file failed', { error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      }
    }
    throwIfCancelled(userId);

    // PayPal sync (best effort: Drive results are kept even if PayPal fails)
    const p1 = scanProgress.get(userId);
    if (p1) p1.stage = 'syncing-paypal';
    await updateScanRunProgress(runId, { stage: 'syncing-paypal' });
    try {
      const end = new Date();
      const start = new Date(end.getTime() - config.paypal.lookbackDays * 86400000);
      counters.transactionsSynced = await syncPaypalTransactions(userId, start, end);
      throwIfCancelled(userId);
    } catch (err) {
      if (err instanceof ScanCancelledError) throw err;
      logWarn('PayPal sync failed, continuing with matching on cached transactions', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (config.razorpay.enabled) {
      // Razorpay sync (best effort, same policy)
      const p1b = scanProgress.get(userId);
      if (p1b) p1b.stage = 'syncing-razorpay';
      await updateScanRunProgress(runId, { stage: 'syncing-razorpay' });
      try {
        const end = new Date();
        const start = new Date(end.getTime() - config.razorpay.lookbackDays * 86400000);
        throwIfCancelled(userId);
        counters.transactionsSynced += await syncRazorpayPayments(userId, start, end);
      } catch (err) {
        if (err instanceof ScanCancelledError) throw err;
        logWarn('Razorpay sync failed, continuing with matching on cached transactions', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

    }
    throwIfCancelled(userId);
    const p2 = scanProgress.get(userId);
    if (p2) p2.stage = 'matching';
    await updateScanRunProgress(runId, { stage: 'matching' });
    const matchStats = await recomputeMatches(userId, runId);
    counters.matchesCreated = matchStats.created;

    await finishScanRun(runId, 'success', counters);
    logInfo('Scan finished', { userId, runId, ...counters });

    // Zapier-style webhook on scan-complete (fire-and-forget, never fails the scan).
    try {
      const { fireScanCompleteWebhook } = await import('./webhooks.js');
      await fireScanCompleteWebhook(userId, {
        runId, trigger: options.trigger, status: 'success',
        filesNew: counters.filesNew, filesRescanned: counters.filesRescanned, transactionsSynced: counters.transactionsSynced,
        matched: matchStats.matched, needsReview: matchStats.review, unmatched: matchStats.unmatched,
        dashboardUrl: `${config.app.publicBaseUrl}/dashboard`,
      });
    } catch {
      // webhook failures are logged inside the helper
    }

    // Notify by email (queued, non-blocking)
    try {
      const { rows } = await query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [userId]);
      if (rows[0]?.email) {
        await sendScanReportEmail(rows[0].email, {
          filesNew: counters.filesNew,
          filesRescanned: counters.filesRescanned,
          matched: matchStats.matched,
          review: matchStats.review,
          unmatched: matchStats.unmatched,
        });
      }
    } catch (err) {
      logWarn('Scan report email failed', { error: err instanceof Error ? err.message : String(err) });
    }

    return { runId, counters };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ScanCancelledError) {
      logInfo('Scan cancelled', { userId, runId });
      if (runId) await finishScanRun(runId, 'cancelled', counters, 'Cancelled by user');
      try {
        const { fireScanCompleteWebhook } = await import('./webhooks.js');
        await fireScanCompleteWebhook(userId, {
          runId: runId ?? null, trigger: options.trigger, status: 'cancelled',
          filesNew: counters.filesNew, filesRescanned: counters.filesRescanned, transactionsSynced: counters.transactionsSynced,
          matched: 0, needsReview: 0, unmatched: 0, dashboardUrl: `${config.app.publicBaseUrl}/dashboard`,
        });
      } catch { /* logged inside helper */ }
      throw err;
    }
    logError('Scan failed', { userId, error: message });
    if (runId) await finishScanRun(runId, 'failed', counters, message);
    try {
      const { fireScanCompleteWebhook } = await import('./webhooks.js');
      await fireScanCompleteWebhook(userId, {
        runId: runId ?? null, trigger: options.trigger, status: 'failed',
        filesNew: counters.filesNew, filesRescanned: counters.filesRescanned, transactionsSynced: counters.transactionsSynced,
        matched: 0, needsReview: 0, unmatched: 0, dashboardUrl: `${config.app.publicBaseUrl}/dashboard`,
      });
    } catch { /* logged inside helper */ }
    throw err;
  } finally {
    runningScans.delete(userId);
    cancelRequested.delete(userId);
    scanProgress.delete(userId);
  }
}

export async function rescanInvoice(userId: string, invoiceId: string): Promise<void> {
  const { rows } = await query<{ drive_file_id: string }>(`SELECT drive_file_id FROM invoices WHERE id=$1 AND user_id=$2`, [invoiceId, userId]);
  if (!rows[0]) throw new Error('Invoice not found');
  await runScan(userId, { trigger: 'rescan-single', forceRescanFileIds: [rows[0].drive_file_id] });
}
