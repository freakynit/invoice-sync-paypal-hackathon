import { query } from '../db/pool.js';
import { logInfo, logWarn } from '../utils/logger.js';

export interface WebhookConfig {
  url: string | null;
  enabled: boolean;
  last_status: string | null;
  last_triggered_at: string | null;
}

const URL_RE = /^https?:\/\/.{4,2000}$/i;

export function isValidWebhookUrl(url: string): boolean {
  if (!URL_RE.test(url.trim())) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function getWebhookConfig(userId: string): Promise<WebhookConfig> {
  const { rows } = await query<WebhookConfig>(`SELECT url, enabled, last_status, last_triggered_at FROM webhook_configs WHERE user_id=$1`, [userId]);
  return rows[0] ?? { url: null, enabled: false, last_status: null, last_triggered_at: null };
}

export async function setWebhookConfig(userId: string, url: string | null, enabled: boolean): Promise<WebhookConfig> {
  const trimmed = (url ?? '').trim();
  if (trimmed && !isValidWebhookUrl(trimmed)) throw new Error('Provide a valid http(s) URL (e.g. your Zapier Catch Hook URL).');
  const { rows } = await query<WebhookConfig>(
    `INSERT INTO webhook_configs (user_id, url, enabled, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id) DO UPDATE SET url=EXCLUDED.url, enabled=EXCLUDED.enabled, updated_at=NOW()
     RETURNING url, enabled, last_status, last_triggered_at`,
    [userId, trimmed || null, trimmed ? enabled : false],
  );
  return rows[0];
}

export interface ScanWebhookPayload {
  event: 'scan.complete';
  runId: string | null;
  trigger: string;
  status: string;
  filesNew: number;
  filesRescanned: number;
  transactionsSynced: number;
  matched: number;
  needsReview: number;
  unmatched: number;
  dashboardUrl: string | null;
  finishedAt: string;
}

export async function deliverWebhook(userId: string, targetUrl: string, payload: ScanWebhookPayload): Promise<{ ok: boolean; status: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'InvoiceSync-scan-webhook/1.0' },
      body: JSON.stringify({ ...payload, userId }),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    const status = res.ok ? `delivered (${res.status})` : `failed (${res.status}): ${body.slice(0, 200)}`;
    await query(`UPDATE webhook_configs SET last_status=$1, last_triggered_at=NOW(), updated_at=NOW() WHERE user_id=$2`, [status, userId]).catch(() => {});
    if (!res.ok) logWarn('Scan webhook delivery failed', { userId, status });
    else logInfo('Scan webhook delivered', { userId, status });
    return { ok: res.ok, status };
  } catch (err) {
    const status = `failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    await query(`UPDATE webhook_configs SET last_status=$1, last_triggered_at=NOW(), updated_at=NOW() WHERE user_id=$2`, [status, userId]).catch(() => {});
    logWarn('Scan webhook delivery failed', { userId, error: status });
    return { ok: false, status };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget Zapier-style POST after a scan finishes. Never throws. */
export async function fireScanCompleteWebhook(userId: string, payload: Omit<ScanWebhookPayload, 'event' | 'finishedAt'>): Promise<void> {
  try {
    const cfg = await getWebhookConfig(userId);
    if (!cfg.enabled || !cfg.url) return;
    const full: ScanWebhookPayload = { ...payload, event: 'scan.complete', finishedAt: new Date().toISOString() };
    // Don't await the HTTP round-trip in the scan path; update status when done.
    void deliverWebhook(userId, cfg.url, full);
  } catch (err) {
    logWarn('Scan webhook skipped', { userId, error: err instanceof Error ? err.message : String(err) });
  }
}
