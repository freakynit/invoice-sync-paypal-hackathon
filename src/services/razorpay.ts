import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { withRetries } from '../utils/retry.js';
import { logInfo } from '../utils/logger.js';

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
  baseUrl: string;
}

export interface RazorpayPaymentNormalized {
  paymentId: string;
  orderId: string | null;
  invoiceId: string | null;
  method: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  payerEmail: string | null;
  payerContact: string | null;
  description: string | null;
  initiatedAt: string | null;
  raw: unknown;
}

export async function getRazorpayCreds(userId: string): Promise<RazorpayCreds> {
  if (!config.razorpay.enabled) throw new Error('Razorpay is disabled.');
  const { rows } = await query<{ key_id: string | null; key_secret: string | null }>(
    `SELECT * FROM razorpay_connections WHERE user_id=$1`,
    [userId],
  );
  const row = rows[0];
  const keyId = row?.key_id || config.razorpay.keyId;
  const keySecret = row?.key_secret || config.razorpay.keySecret;
  const baseUrl = config.razorpay.baseUrl;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials are missing. Add your Key ID & Key Secret in Dashboard → Razorpay.');
  return { keyId, keySecret, baseUrl };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Razorpay reports amounts in the smallest currency unit (paise for INR).
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'PYG', 'DJF']);
export function fromMinorUnits(amount: number, currency: string | null): number {
  const code = (currency ?? '').toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return amount;
  return amount / (['KWD', 'BHD', 'OMR'].includes(code) ? 1000 : 100);
}

/**
 * List payments via GET /v1/payments (paginated with skip/count).
 * Docs: https://razorpay.com/docs/api/payments/fetch-all-payments/
 */
export async function fetchRazorpayPayments(userId: string, startDate: Date, endDate: Date): Promise<RazorpayPaymentNormalized[]> {
  const creds = await getRazorpayCreds(userId);
  const auth = 'Basic ' + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
  const out: RazorpayPaymentNormalized[] = [];
  let skip = 0;
  const count = Math.min(100, Math.max(1, Math.floor(config.razorpay.pageSize)));

  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      from: String(Math.floor(startDate.getTime() / 1000)),
      to: String(Math.floor(endDate.getTime() / 1000)),
      count: String(count),
      skip: String(skip),
    });
    const url = `${creds.baseUrl}/payments?${params.toString()}`;

    const data = await withRetries({ maxRetries: 4, baseMs: 1000, maxMs: 15000, operationName: 'Razorpay list payments' }, async () => {
      const res = await fetch(url, {
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(config.razorpay.timeoutMs),
      });
      if (!res.ok) {
        const err = new Error(`Razorpay payments failed: ${res.status}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as { items?: unknown[] };
    });

    if (!Array.isArray(data.items)) throw new Error('Invalid Razorpay payments response: items missing');
    const items = data.items;
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const currency = p.currency ? String(p.currency) : null;
      const amount = toNumber(p.amount);
      out.push({
        paymentId: String(p.id ?? ''),
        orderId: p.order_id ? String(p.order_id) : null,
        invoiceId: p.invoice_id ? String(p.invoice_id) : null,
        method: p.method ? String(p.method) : null,
        status: p.status ? String(p.status) : null,
        amount: amount === null ? null : fromMinorUnits(amount, currency),
        currency,
        payerEmail: p.email ? String(p.email) : null,
        payerContact: p.contact ? String(p.contact) : null,
        description: p.description ? String(p.description) : null,
        initiatedAt: p.created_at ? new Date(Number(p.created_at) * 1000).toISOString() : null,
        raw: item,
      });
    }

    logInfo('Razorpay page fetched', { skip, count: items.length });
    if (items.length < count) break;
    if (page >= config.razorpay.maxPages) throw new Error('Razorpay date range exceeds pagination limit; coverage was not cached.');
    skip += items.length;

  }

  return out.filter((p) => p.paymentId);
}

export async function upsertRazorpayPayments(userId: string, payments: RazorpayPaymentNormalized[], execute: (sql: string, params: unknown[]) => Promise<unknown> = query): Promise<number> {
  // A repeated conflict key in one INSERT cannot be updated twice. Keep the last
  // observation, as the previous sequential upserts did; null dates remain distinct.
  const unique = new Map<string, typeof payments[number]>();
  for (const [i, p] of payments.entries()) {
    const key = p.paymentId + ':' + (p.initiatedAt ? new Date(p.initiatedAt).toISOString() : `null:${i}`);
    unique.set(key, p);
  }
  const rows = [...unique.values()];
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const params: unknown[] = [];
    const placeholders = batch.map((p, i) => {
      params.push(userId, p.paymentId, p.orderId, p.invoiceId, p.method, p.status, p.amount, p.currency, p.payerEmail, p.payerContact, p.description, p.initiatedAt, JSON.stringify(p.raw));
      return '(' + Array.from({ length: 13 }, (_, j) => `$${i * 13 + j + 1}`).join(',') + ',NOW())';
    }).join(',');
    await execute(`INSERT INTO razorpay_payments
        (user_id, razorpay_payment_id, razorpay_order_id, razorpay_invoice_id, method, status, amount, currency,
         payer_email, payer_contact, description, transaction_initiated_at, raw_json, updated_at)
       VALUES ${placeholders}
       ON CONFLICT (user_id, razorpay_payment_id, transaction_initiated_at)
       DO UPDATE SET razorpay_order_id=EXCLUDED.razorpay_order_id, razorpay_invoice_id=EXCLUDED.razorpay_invoice_id,
         method=EXCLUDED.method, status=EXCLUDED.status, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
         payer_email=EXCLUDED.payer_email, payer_contact=EXCLUDED.payer_contact, description=EXCLUDED.description,
         raw_json=EXCLUDED.raw_json, updated_at=NOW()`, params);
  }
  return payments.length;
}

// Account isolation: changing credentials invalidates that user's cached coverage and Razorpay matches.
export async function ensureRazorpayCacheAccount(userId: string): Promise<string> {
  const creds = await getRazorpayCreds(userId);
  const key = createHash('sha256').update(`${creds.baseUrl}:${creds.keyId}`).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    const { rows } = await client.query('SELECT account_key FROM razorpay_cache_accounts WHERE user_id=$1', [userId]);
    if (rows[0] && rows[0].account_key !== key) {
      await client.query('DELETE FROM invoice_matches WHERE user_id=$1 AND razorpay_payment_id IS NOT NULL', [userId]);
      await client.query('DELETE FROM razorpay_payments WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM razorpay_cache_days WHERE user_id=$1', [userId]);
    }
    await client.query('INSERT INTO razorpay_cache_accounts (user_id,account_key) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET account_key=EXCLUDED.account_key', [userId, key]);
    await client.query('COMMIT');
    return key;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

const cacheWork = new Map<string, Promise<unknown>>();
const DAY = 86400000;

export async function syncRazorpayPayments(userId: string, startDate: Date, endDate: Date): Promise<number> {
  if (!config.razorpay.enabled) return 0;
  const prior = cacheWork.get(userId) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const accountKey = await ensureRazorpayCacheAccount(userId);
    const start = startDate.getTime(), end = Math.min(endDate.getTime(), Date.now());
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Invalid Razorpay date range');
    const first = Math.floor(start / DAY) * DAY, last = Math.floor(end / DAY) * DAY;
    const { rows } = await query<{ day: string; covered_until: string; fetched_at: string }>(
      'SELECT day::text,covered_until,fetched_at FROM razorpay_cache_days WHERE user_id=$1 AND account_key=$2 AND day BETWEEN $3 AND $4',
      [userId, accountKey, new Date(first).toISOString().slice(0, 10), new Date(last).toISOString().slice(0, 10)]);
    const coverage = new Map(rows.map(r => [r.day, r]));
    const missing: number[] = [];
    const now = Date.now();
    for (let day = first; day <= last; day += DAY) {
      const row = coverage.get(new Date(day).toISOString().slice(0, 10));
      const recent = now - day < config.razorpay.cacheRecentDays * DAY;
      const ttl = recent ? config.razorpay.cacheFreshMinutes * 60000 : config.razorpay.cacheHistoricalHours * 3600000;
      const finishedDay = day + DAY <= now;
      if (!row || now - new Date(row.fetched_at).getTime() > ttl || (finishedDay && new Date(row.covered_until).getTime() < day + DAY - 1000)) missing.push(day);
    }
    let stored = 0;
    for (let i = 0; i < missing.length;) {
      const days = [missing[i++]];
      // Batch up to 30 days per request window.
      while (i < missing.length && missing[i] === days[days.length - 1] + DAY && days.length < 30) days.push(missing[i++]);
      const from = days[0], until = Math.min(days[days.length - 1] + DAY - 1000, Math.floor(now / 1000) * 1000);
      const payments = await fetchRazorpayPayments(userId, new Date(from), new Date(until));
      // Do not mix an in-flight response with a newly selected account.
      if (await ensureRazorpayCacheAccount(userId) !== accountKey) throw new Error('Razorpay account changed during sync. Retry.');
      stored += await upsertRazorpayPayments(userId, payments);
      for (const day of days) await query(`INSERT INTO razorpay_cache_days (user_id,account_key,day,covered_until,fetched_at)
        VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (user_id,account_key,day) DO UPDATE SET covered_until=EXCLUDED.covered_until,fetched_at=NOW()`,
        [userId, accountKey, new Date(day).toISOString().slice(0, 10), new Date(Math.min(day + DAY - 1000, until)).toISOString()]);
    }
    logInfo('Razorpay cache sync', { userId, cachedDays: rows.length, requestedDays: missing.length, stored });
    return stored;
  });
  cacheWork.set(userId, task);
  try { return await task; } finally { if (cacheWork.get(userId) === task) cacheWork.delete(userId); }
}

/** Returns stored payments, fetching only uncovered or stale date ranges first. */
export async function fetchRazorpayStoredPayments(userId: string, startDate: Date, endDate: Date): Promise<RazorpayPaymentNormalized[]> {
  await syncRazorpayPayments(userId, startDate, endDate);
  const { rows } = await query<any>('SELECT * FROM razorpay_payments WHERE user_id=$1 AND transaction_initiated_at BETWEEN $2 AND $3 ORDER BY transaction_initiated_at DESC', [userId, startDate.toISOString(), endDate.toISOString()]);
  return rows.map(t => ({
    paymentId: t.razorpay_payment_id, orderId: t.razorpay_order_id, invoiceId: t.razorpay_invoice_id, method: t.method, status: t.status,
    amount: t.amount === null ? null : Number(t.amount), currency: t.currency, payerEmail: t.payer_email, payerContact: t.payer_contact,
    description: t.description, initiatedAt: t.transaction_initiated_at, raw: t.raw_json,
  }));
}
