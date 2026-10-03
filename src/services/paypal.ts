import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { withRetries } from '../utils/retry.js';
import { logInfo } from '../utils/logger.js';

export interface PaypalCreds {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export interface PaypalTransactionNormalized {
  transactionId: string;
  referenceId: string | null;
  eventCode: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  fee: number | null;
  payerEmail: string | null;
  payerName: string | null;
  initiatedAt: string | null;
  updatedAt: string | null;
  raw: unknown;
}

const cachedTokens = new Map<string, { value: string; expiresAt: number }>();
const tokenRequests = new Map<string, Promise<string>>();

export async function getPaypalCreds(userId: string): Promise<PaypalCreds> {
  const { rows } = await query<{ client_id: string | null; client_secret: string | null; base_url: string | null; mode: string }>(
    `SELECT * FROM paypal_connections WHERE user_id=$1`,
    [userId],
  );
  const row = rows[0];
  const clientId = row?.client_id || config.paypal.clientId;
  const clientSecret = row?.client_secret || config.paypal.clientSecret;
  const baseUrl = (row?.base_url || config.paypal.baseUrl).replace(/\/$/, '');
  if (!clientId || !clientSecret) throw new Error('PayPal sandbox credentials are missing. Add them in Dashboard → Settings.');
  return { clientId, clientSecret, baseUrl };
}

async function fetchAccessToken(creds: PaypalCreds): Promise<string> {
  // Include a secret fingerprint so rotating credentials invalidates the token.
  const cacheKey = createHash('sha256').update(JSON.stringify([creds.baseUrl, creds.clientId, creds.clientSecret])).digest('hex');
  const cached = cachedTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const pending = tokenRequests.get(cacheKey);
  if (pending) return pending;
  const task = requestAccessToken(creds, cacheKey);
  tokenRequests.set(cacheKey, task);
  try { return await task; }
  finally { if (tokenRequests.get(cacheKey) === task) tokenRequests.delete(cacheKey); }
}

async function requestAccessToken(creds: PaypalCreds, cacheKey: string): Promise<string> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const res = await fetch(`${creds.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(config.paypal.timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`PayPal OAuth failed: ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  if (!data.access_token || !Number.isFinite(data.expires_in)) throw new Error('Invalid PayPal token response');
  for (const [key, token] of cachedTokens) if (token.expiresAt <= Date.now() + 60_000) cachedTokens.delete(key);
  if (cachedTokens.size >= 1000) cachedTokens.delete(cachedTokens.keys().next().value!);
  cachedTokens.set(cacheKey, { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export const REPORTING_SCOPE_GUIDE =
  'PayPal Transaction Search returned NOT_AUTHORIZED. The sandbox REST app is missing the reporting scope. ' +
  'Fix: developer.paypal.com → Apps & Credentials → your sandbox app → enable "Transaction Search" under feature options, ' +
  'then retry. Meanwhile you can still create real sandbox test payments via Dashboard → Settings → Sandbox test payments ' +
  '(approve the order links, then Capture — captures are stored immediately without Transaction Search).';

function describeReportingError(status: number): string | null {
  if (status === 401 || status === 403) return REPORTING_SCOPE_GUIDE;
  return null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * List sandbox transactions via Transaction Search API.
 * Docs: GET {base}/v1/reporting/transactions?start_date=...&end_date=...&fields=all&page=..&page_size=..
 */
async function fetchRemoteTransactions(userId: string, startDate: Date, endDate: Date): Promise<PaypalTransactionNormalized[]> {
  const creds = await getPaypalCreds(userId);
  const out: PaypalTransactionNormalized[] = [];
  let page = 1;
  const pageSize = Math.min(500, Math.max(1, config.paypal.pageSize));

  for (;;) {
    const params = new URLSearchParams({
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      fields: 'all',
      page: String(page),
      page_size: String(pageSize),
    });
    const url = `${creds.baseUrl}/v1/reporting/transactions?${params.toString()}`;

    let data: { transaction_details?: unknown[]; total_pages?: number };
    try {
      data = await withRetries({ maxRetries: 4, baseMs: 1000, maxMs: 15000, operationName: 'PayPal list transactions' }, async () => {
        const token = await fetchAccessToken(creds);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(config.paypal.timeoutMs),
        });
        if (!res.ok) {
          const err = new Error(`PayPal transactions failed: ${res.status}`) as Error & { status: number };
          err.status = res.status;
          throw err;
        }
        return (await res.json()) as { transaction_details?: unknown[]; total_pages?: number };
      });
    } catch (err) {
      const status = Number((err as { status?: unknown }).status ?? NaN);
      const guide = Number.isFinite(status) ? describeReportingError(status) : null;
      if (guide) throw new Error(guide);
      throw err;
    }

    const details = Array.isArray(data.transaction_details) ? data.transaction_details : [];
    for (const item of details) {
      const d = item as Record<string, Record<string, unknown> | string | undefined>;
      const info = (d.transaction_info ?? {}) as Record<string, unknown>;
      const payer = (d.payer_info ?? {}) as Record<string, unknown>;
      const amountObj = (info.transaction_amount ?? {}) as Record<string, unknown>;
      const feeObj = (info.fee_amount ?? {}) as Record<string, unknown>;
      out.push({
        transactionId: String(info.transaction_id ?? ''),
        referenceId: info.paypal_reference_id ? String(info.paypal_reference_id) : null,
        eventCode: info.transaction_event_code ? String(info.transaction_event_code) : null,
        status: info.transaction_status ? String(info.transaction_status) : null,
        amount: toNumber(amountObj.value),
        currency: amountObj.currency_code ? String(amountObj.currency_code) : null,
        fee: toNumber(feeObj.value),
        payerEmail: payer.email_address ? String(payer.email_address) : ((d as Record<string, unknown>).payer_email ? String((d as Record<string, unknown>).payer_email) : null),
        payerName: payer.payer_name ? String((payer.payer_name as Record<string, unknown>).alternate_full_name ?? (payer.payer_name as Record<string, unknown>).given_name ?? '') || null : null,
        initiatedAt: info.transaction_initiation_date ? String(info.transaction_initiation_date) : null,
        updatedAt: info.transaction_updated_date ? String(info.transaction_updated_date) : null,
        raw: item,
      });
    }

    const totalPages = Number((data as { total_pages?: unknown }).total_pages ?? 1);
    logInfo('PayPal page fetched', { page, totalPages, count: details.length });
    if (page >= totalPages || details.length === 0) break;
    page++;
    if (page > config.paypal.maxPages) throw new Error('PayPal date range exceeds pagination limit; coverage was not cached.');
  }

  return out.filter((t) => t.transactionId);
}

export async function upsertPaypalTransactions(userId: string, txns: PaypalTransactionNormalized[], execute: (sql: string, params: unknown[]) => Promise<unknown> = query): Promise<number> {
  // A repeated conflict key in one INSERT cannot be updated twice. Keep the last
  // observation, as the previous sequential upserts did; null dates remain distinct.
  const unique = new Map<string, typeof txns[number]>();
  for (const [i, t] of txns.entries()) {
    const key = t.transactionId + ':' + (t.initiatedAt ? new Date(t.initiatedAt).toISOString() : `null:${i}`);
    unique.set(key, t);
  }
  const rows = [...unique.values()];
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const params: unknown[] = [];
    const placeholders = batch.map((t, i) => {
      params.push(userId, t.transactionId, t.referenceId, t.eventCode, t.status, t.amount, t.currency, t.fee, t.payerEmail, t.payerName, t.initiatedAt, t.updatedAt, JSON.stringify(t.raw));
      return '(' + Array.from({ length: 13 }, (_, j) => `$${i * 13 + j + 1}`).join(',') + ',NOW())';
    }).join(',');
    await execute(`INSERT INTO paypal_transactions
        (user_id, paypal_transaction_id, paypal_reference_id, event_code, status, amount, currency, fee, payer_email, payer_name, transaction_initiated_at, transaction_updated_at, raw_json, updated_at)
       VALUES ${placeholders}
       ON CONFLICT (user_id, paypal_transaction_id, transaction_initiated_at)
       DO UPDATE SET paypal_reference_id=EXCLUDED.paypal_reference_id, event_code=EXCLUDED.event_code,
         status=EXCLUDED.status, amount=EXCLUDED.amount, currency=EXCLUDED.currency, fee=EXCLUDED.fee,
         payer_email=EXCLUDED.payer_email, payer_name=EXCLUDED.payer_name,
         transaction_updated_at=EXCLUDED.transaction_updated_at, raw_json=EXCLUDED.raw_json, updated_at=NOW()`, params);
  }
  return txns.length;
}

// Account isolation: changing credentials invalidates that user's cached coverage and assignments.
export async function ensurePaypalCacheAccount(userId: string): Promise<string> {
  const creds = await getPaypalCreds(userId);
  const key = createHash('sha256').update(`${creds.baseUrl}:${creds.clientId}`).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[userId]);
    const {rows} = await client.query('SELECT account_key FROM paypal_cache_accounts WHERE user_id=$1',[userId]);
    if (rows[0] && rows[0].account_key !== key) {
      await client.query('DELETE FROM invoice_matches WHERE user_id=$1 AND paypal_transaction_id IS NOT NULL',[userId]);
      await client.query('DELETE FROM paypal_transactions WHERE user_id=$1',[userId]);
      await client.query('DELETE FROM paypal_cache_days WHERE user_id=$1',[userId]);
    }
    await client.query('INSERT INTO paypal_cache_accounts (user_id,account_key) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET account_key=EXCLUDED.account_key',[userId,key]);
    await client.query('COMMIT');
    return key;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
const cacheWork = new Map<string,Promise<unknown>>();
const DAY = 86400000;

export async function syncPaypalTransactions(userId: string, startDate: Date, endDate: Date): Promise<number> {
  const prior = cacheWork.get(userId) ?? Promise.resolve();
  const task = prior.catch(()=>{}).then(async () => {
    const accountKey = await ensurePaypalCacheAccount(userId);
    const start = startDate.getTime(), end = Math.min(endDate.getTime(),Date.now());
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Invalid PayPal date range');
    const first = Math.floor(start / DAY) * DAY, last = Math.floor(end / DAY) * DAY;
    const {rows} = await query<{day:string;covered_until:string;fetched_at:string}>(
      'SELECT day::text,covered_until,fetched_at FROM paypal_cache_days WHERE user_id=$1 AND account_key=$2 AND day BETWEEN $3 AND $4',
      [userId,accountKey,new Date(first).toISOString().slice(0,10),new Date(last).toISOString().slice(0,10)]);
    const coverage = new Map(rows.map(r=>[r.day,r]));
    const missing:number[] = [];
    const now = Date.now();
    for (let day=first;day<=last;day+=DAY) {
      const row = coverage.get(new Date(day).toISOString().slice(0,10));
      const recent = now-day < config.paypal.cacheRecentDays*DAY;
      const ttl = recent ? config.paypal.cacheFreshMinutes*60000 : config.paypal.cacheHistoricalHours*3600000;
      const finishedDay = day+DAY <= now;
      if (!row || now-new Date(row.fetched_at).getTime()>ttl || (finishedDay && new Date(row.covered_until).getTime()<day+DAY-1000)) missing.push(day);
    }
    let stored=0;
    for (let i=0;i<missing.length;) {
      const days=[missing[i++]];
      // PayPal permits at most 31 days per request; keep each request within 30 days.
      while (i<missing.length && missing[i]===days[days.length-1]+DAY && days.length<30) days.push(missing[i++]);
      const from = days[0], until = Math.min(days[days.length-1]+DAY-1000,Math.floor(now/1000)*1000);
      const txns = await fetchRemoteTransactions(userId,new Date(from),new Date(until));
      // Do not mix an in-flight response with a newly selected account.
      if (await ensurePaypalCacheAccount(userId) !== accountKey) throw new Error('PayPal account changed during sync. Retry.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[userId]);
        const account = await client.query('SELECT account_key FROM paypal_cache_accounts WHERE user_id=$1',[userId]);
        if (account.rows[0]?.account_key !== accountKey) throw new Error('PayPal account changed during sync. Retry.');
        const count = await upsertPaypalTransactions(userId,txns,(sql,params)=>client.query(sql,params));
        for (const day of days) await client.query(`INSERT INTO paypal_cache_days (user_id,account_key,day,covered_until,fetched_at)
          VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (user_id,account_key,day) DO UPDATE SET covered_until=EXCLUDED.covered_until,fetched_at=NOW()`,
          [userId,accountKey,new Date(day).toISOString().slice(0,10),new Date(Math.min(day+DAY-1000,until)).toISOString()]);
        await client.query('COMMIT');
        stored += count;
      } catch(err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    }
    logInfo('PayPal cache sync', {userId,cachedDays:rows.length,requestedDays:missing.length,stored});
    return stored;
  });
  cacheWork.set(userId,task);
  try { return await task; } finally { if(cacheWork.get(userId)===task) cacheWork.delete(userId); }
}

/** Returns stored transactions, fetching only uncovered or stale date ranges first. */
export async function fetchPaypalTransactions(userId: string, startDate: Date, endDate: Date): Promise<PaypalTransactionNormalized[]> {
  await syncPaypalTransactions(userId,startDate,endDate);
  const {rows} = await query<any>('SELECT * FROM paypal_transactions WHERE user_id=$1 AND transaction_initiated_at BETWEEN $2 AND $3 ORDER BY transaction_initiated_at DESC',[userId,startDate.toISOString(),endDate.toISOString()]);
  return rows.map(t=>({transactionId:t.paypal_transaction_id,referenceId:t.paypal_reference_id,eventCode:t.event_code,status:t.status,
    amount:t.amount===null?null:Number(t.amount),currency:t.currency,fee:t.fee===null?null:Number(t.fee),payerEmail:t.payer_email,payerName:t.payer_name,
    initiatedAt:t.transaction_initiated_at,updatedAt:t.transaction_updated_at,raw:t.raw_json}));
}

export async function clearPaypalCache(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[userId]);
    await client.query('DELETE FROM invoice_matches WHERE user_id=$1 AND paypal_transaction_id IS NOT NULL',[userId]);
    await client.query('DELETE FROM paypal_transactions WHERE user_id=$1',[userId]);
    await client.query('DELETE FROM paypal_cache_days WHERE user_id=$1',[userId]);
    await client.query('DELETE FROM paypal_cache_accounts WHERE user_id=$1',[userId]);
    await client.query('COMMIT');
  } catch(err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
