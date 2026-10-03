import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { ensurePaypalCacheAccount, syncPaypalTransactions } from './paypal.js';
import { ensureRazorpayCacheAccount, syncRazorpayPayments } from './razorpay.js';
import { logWarn } from '../utils/logger.js';

export interface InvoiceRow {
  id: string; user_id: string; drive_file_id: string; invoice_number: string | null;
  vendor_name: string | null; amount: string | null; currency: string | null;
  invoice_date: string | null; payer_email: string | null;
}
export interface TxnRow {
  id: string; provider: 'paypal' | 'razorpay';
  provider_transaction_id: string; provider_reference_id: string | null;
  amount: string | null; currency: string | null; payer_email: string | null;
  transaction_initiated_at: string | null; raw_json: unknown; status: string | null;
  event_code: string | null; assigned_invoice_id?: string | null;
}
export interface MatchScore {
  score: number; percentage: number; reasons: string[]; conflicts: string[];
  identifierRank: number; eligible: boolean; amountExact: boolean; currencyExact: boolean; emailExact: boolean;
}
export type Candidate = TxnRow & MatchScore;
const normalize = (v: unknown): string => typeof v === 'string' ? v.trim().toLowerCase() : '';

function fields(raw: unknown, keys: Set<string>, out: string[] = []): string[] {
  if (Array.isArray(raw)) for (const v of raw) fields(v, keys, out);
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) {
    if (keys.has(k) && typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') fields(v, keys, out);
  }
  return out;
}
function dateDistance(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const days = Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;
  return Number.isFinite(days) ? days : null;
}
export function scoreMatch(invoice: InvoiceRow, txn: TxnRow): MatchScore {
  const reasons: string[] = [], conflicts: string[] = [];
  let score = 0, identifierRank = 0;
  const number = normalize(invoice.invoice_number);
  const provider = txn.provider ?? 'paypal';
  // Razorpay's top-level invoice_id identifies its own invoice entity.
  const invoiceFields = provider === 'razorpay' && txn.raw_json && typeof txn.raw_json === 'object'
    ? { ...(txn.raw_json as Record<string, unknown>), invoice_id: undefined } : txn.raw_json;
  const invoiceIds = fields(invoiceFields, new Set(['invoice_id', 'invoice_number'])).map(normalize).filter(Boolean);
  const customIds = fields(txn.raw_json, new Set(['custom_id', 'custom_field'])).map(normalize);
  if (number && invoiceIds.includes(number)) {
    identifierRank = 3; score += 100; reasons.push('Exact invoice number in payment invoice field');
  } else if (number && customIds.some(v => v === number || v === `invoice-sync:${number}`)) {
    identifierRank = 2; score += 80; reasons.push('Exact invoice number in merchant custom field');
  } else if (number) {
    const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'iu');
    if (fields(txn.raw_json, new Set(['description', 'transaction_subject', 'transaction_note', 'note'])).some(v => token.test(v))) {
      score += 15; reasons.push('Invoice number mentioned in payment description');
    }
  }
  if (number && invoiceIds.length && !invoiceIds.includes(number)) conflicts.push('Payment invoice number differs');
  const a = invoice.amount === null ? NaN : Number(invoice.amount);
  const b = txn.amount === null ? NaN : Number(txn.amount);
  const diff = Math.abs(a - b);
  const amountExact = Number.isFinite(diff) && diff <= config.matching.amountTolerance + 1e-9;
  if (amountExact) { score += 30; reasons.push('Exact amount'); }
  else if (!Number.isFinite(diff)) conflicts.push('Amount missing; cannot validate payment total');
  else if (Number.isFinite(diff)) {
    conflicts.push(`Amount differs by ${diff.toFixed(2)}`);
    if (diff <= 1) { score += 5; reasons.push('Amount within 1 currency unit'); }
  }
  const currencyExact = Boolean(invoice.currency && txn.currency && normalize(invoice.currency) === normalize(txn.currency));
  if (currencyExact) { score += 10; reasons.push('Matching currency'); }
  else conflicts.push(invoice.currency && txn.currency ? 'Currency differs' : 'Currency missing; cannot validate payment');
  const emailExact = Boolean(invoice.payer_email && txn.payer_email && normalize(invoice.payer_email) === normalize(txn.payer_email));
  if (emailExact) { score += 20; reasons.push('Matching payer email'); }
  else if (invoice.payer_email && txn.payer_email) conflicts.push('Payer email differs');
  const days = dateDistance(invoice.invoice_date, txn.transaction_initiated_at);
  if (days !== null && days <= 3) { score += 10; reasons.push(`Date within ${days.toFixed(1)} days`); }
  else if (days !== null && days <= config.matching.dateToleranceDays) { score += 5; reasons.push(`Date within ${days.toFixed(1)} days`); }
  const successful = provider === 'razorpay'
    ? (txn.status || '').toLowerCase() === 'captured'
    : ['S', 'COMPLETED'].includes((txn.status || '').toUpperCase());
  const payment = provider === 'razorpay'
    ? true
    : /^T00/.test(txn.event_code || '') && !['T0008','T0014','T0015','T0016','T0017','T0020'].includes(txn.event_code || '');
  if (!successful) conflicts.push(`Payment is ${txn.status || 'of unknown status'}`);
  if (!payment) conflicts.push('Transaction is not an eligible invoice payment');
  if (txn.assigned_invoice_id && txn.assigned_invoice_id !== invoice.id) conflicts.push('Already matched to another invoice');
  // Strength is a heuristic, not a probability. Identifier matches occupy the highest band.
  const percentage = Math.min(100, identifierRank === 3 ? 85 + Math.round((score - 100) * 15 / 70)
    : identifierRank === 2 ? 75 + Math.round((score - 80) * 20 / 70) : Math.min(70, score));
  return { score, percentage, reasons, conflicts, identifierRank, eligible: successful && payment, amountExact, currencyExact, emailExact };
}
export async function getInvoice(userId: string, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await query<InvoiceRow>('SELECT * FROM invoices WHERE id=$1 AND user_id=$2', [invoiceId, userId]);
  if (!rows[0]) throw new Error('Invoice not found');
  return rows[0];
}
async function ensureCacheAccounts(userId: string): Promise<void> {
  // A provider that isn't configured simply contributes no candidates.
  await ensurePaypalCacheAccount(userId).catch((err) => {
    logWarn('PayPal cache account check skipped', { error: err instanceof Error ? err.message : String(err) });
  });
  if (config.razorpay.enabled) await ensureRazorpayCacheAccount(userId).catch((err) => {
    logWarn('Razorpay cache account check skipped', { error: err instanceof Error ? err.message : String(err) });
  });
}
async function transactions(userId: string, invoiceIds: string[] | null = null): Promise<TxnRow[]> {
  await ensureCacheAccounts(userId);
  const { rows } = await query<TxnRow>(`WITH stored AS (SELECT 'paypal' AS provider, t.id, t.paypal_transaction_id AS provider_transaction_id,
    t.paypal_reference_id AS provider_reference_id, t.amount, t.currency, t.payer_email,
    t.transaction_initiated_at, t.raw_json, t.status, t.event_code, m.invoice_id AS assigned_invoice_id
    FROM paypal_transactions t
    LEFT JOIN invoice_matches m ON m.paypal_transaction_id=t.id AND m.status='matched' AND m.user_id=t.user_id
    WHERE t.user_id=$1
    UNION ALL
    SELECT 'razorpay', r.id, r.razorpay_payment_id, r.razorpay_order_id, r.amount, r.currency, r.payer_email,
      r.transaction_initiated_at, r.raw_json, r.status, r.method, m.invoice_id
    FROM razorpay_payments r
    LEFT JOIN invoice_matches m ON m.razorpay_payment_id=r.id AND m.status='matched' AND m.user_id=r.user_id
    WHERE r.user_id=$1 AND $2::boolean
    ), eligible AS (
      SELECT id, currency FROM stored WHERE
        (provider='razorpay' AND LOWER(status)='captured') OR
        (provider='paypal' AND UPPER(status) IN ('S','COMPLETED') AND event_code ~ '^T00'
         AND event_code NOT IN ('T0008','T0014','T0015','T0016','T0017','T0020'))
    ), eligible_fallback AS (
      SELECT id FROM eligible ORDER BY id LIMIT 2
    ), currency_ranked AS (
      SELECT id, LOWER(BTRIM(currency)) AS currency,
        ROW_NUMBER() OVER (PARTITION BY LOWER(BTRIM(currency)) ORDER BY id) AS rank FROM eligible
    )
    SELECT t.* FROM stored t WHERE $3::uuid[] IS NULL OR t.id IN (SELECT id FROM eligible_fallback) OR EXISTS (
      SELECT 1 FROM invoices i WHERE i.user_id=$1 AND i.id=ANY($3::uuid[]) AND (
        t.id IN (SELECT id FROM currency_ranked c WHERE c.rank <= 2 AND c.currency=LOWER(BTRIM(i.currency))) OR
        LOWER(BTRIM(i.payer_email))=LOWER(BTRIM(t.payer_email)) OR
        ABS(i.amount-t.amount) <= $4 OR
        ABS(EXTRACT(EPOCH FROM (i.invoice_date::timestamp AT TIME ZONE 'UTC')-t.transaction_initiated_at)) <= $5 OR
        (NULLIF(BTRIM(i.invoice_number),'') IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_path_query(t.raw_json, '$.** ? (@.type() == "string")') AS v(value)
          WHERE STRPOS(LOWER(UPPER(v.value #>> '{}')), LOWER(UPPER(BTRIM(i.invoice_number)))) > 0
        ))
      )
    ) ORDER BY transaction_initiated_at DESC NULLS LAST, id`,
    [userId, config.razorpay.enabled, invoiceIds, Math.max(1, config.matching.amountTolerance+1e-9),
      Math.max(3, config.matching.dateToleranceDays)*86400]);
  return rows;
}
function ranked(invoice: InvoiceRow, txns: TxnRow[]): Candidate[] {
  return txns.map(t => ({ ...t, ...scoreMatch(invoice, t) })).sort((a,b) =>
    Number(b.eligible) - Number(a.eligible) || b.identifierRank - a.identifierRank || b.score - a.score || a.id.localeCompare(b.id));
}
export async function syncInvoicePayments(userId: string, range: {start: Date; end: Date}) {
  const results = await Promise.allSettled([
    syncPaypalTransactions(userId,range.start,range.end),
    ...(config.razorpay.enabled ? [syncRazorpayPayments(userId,range.start,range.end)] : []),
  ]);
  let fetched=0, succeeded=0;
  const warnings:string[]=[];
  for(const result of results) {
    if(result.status==='fulfilled') { fetched+=result.value; succeeded++; }
    else {
      const message=result.reason instanceof Error ? result.reason.message : String(result.reason);
      if(!/credentials are missing/i.test(message)) warnings.push(message);
    }
  }
  if(!succeeded) throw new Error(warnings.join('; ') || 'Connect a payment provider before syncing payments.');
  return {fetched,warnings};
}
export async function getCandidates(userId: string, invoiceId: string, search = '') {
  const invoice = await getInvoice(userId, invoiceId);
  let all = ranked(invoice, await transactions(userId));
  const term = normalize(search);
  let syncError: string | null = null;
  if (!term && !all.some(c => c.eligible && (c.identifierRank >= 2 || (c.amountExact && c.currencyExact) || (c.emailExact && c.score >= 35)))) {
    try {
      const range = invoiceRange(invoice);
      const synced = await syncInvoicePayments(userId,range);
      syncError = synced.warnings.join('; ') || null;
      all = ranked(invoice,await transactions(userId));
    } catch (err) { syncError = err instanceof Error ? err.message : String(err); }
  }
  return { invoice, candidates: all.filter(c => !term || [c.provider_transaction_id, c.payer_email, c.amount, ...fields(c.raw_json, new Set(['invoice_id','custom_id','custom_field']))].some(v => normalize(v).includes(term))).slice(0, 30), total: all.length, syncError };
}
function decision(candidates: Candidate[], invoiceId: string) {
  const best = candidates.find(c => c.eligible);
  if (!best || best.score === 0) return { best: null, status: 'unmatched', reasons: ['No eligible payment with matching signals'] };
  const reasons = [...best.reasons, ...best.conflicts];
  const next = candidates.find(c => c.eligible && c.id !== best.id);
  const ambiguous = next && next.identifierRank === best.identifierRank && best.score - next.score < config.matching.ambiguityMargin;
  if (ambiguous) reasons.push('Multiple similarly strong payments; choose one manually');
  const available = !best.assigned_invoice_id || best.assigned_invoice_id === invoiceId;
  const exactIdentity = best.identifierRank >= 2;
  const safe = best.amountExact && best.currencyExact && best.conflicts.length === 0 && (exactIdentity || best.emailExact);
  const status = safe && best.percentage >= config.matching.matchedThreshold && !ambiguous && available ? 'matched'
    : best.identifierRank > 0 || best.percentage >= config.matching.reviewThreshold ? 'needs_review' : 'unmatched';
  return { best, status, reasons };
}
async function persist(userId: string, invoiceId: string, best: Candidate | null, status: string, reasons: string[], decisionType: string, scanRunId: string | null = null, replaceManual = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    await client.query('SELECT id FROM invoices WHERE id=$1 AND user_id=$2 FOR UPDATE', [invoiceId,userId]);
    const isRazorpay = best?.provider === 'razorpay';
    if (best && status === 'matched') {
      const used = await client.query(`SELECT invoice_id FROM invoice_matches WHERE user_id=$1 AND status='matched' AND (paypal_transaction_id=$2 OR razorpay_payment_id=$2) AND invoice_id<>$3`, [userId,best.id,invoiceId]);
      if (used.rows.length) {
        if (decisionType === 'manual') throw new Error('This payment is already matched to another invoice. Unmatch that invoice first.');
        status = 'needs_review'; reasons.push('Already matched to another invoice');
      }
    }
    const result = await client.query(`INSERT INTO invoice_matches (user_id,invoice_id,paypal_transaction_id,razorpay_payment_id,score,percentage,status,reasons,decision,scan_run_id,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT (invoice_id) DO UPDATE SET
      paypal_transaction_id=EXCLUDED.paypal_transaction_id, razorpay_payment_id=EXCLUDED.razorpay_payment_id, score=EXCLUDED.score, percentage=EXCLUDED.percentage,
      status=EXCLUDED.status,reasons=EXCLUDED.reasons,decision=EXCLUDED.decision,scan_run_id=EXCLUDED.scan_run_id,updated_at=NOW()
      WHERE $11 OR $9 <> 'auto' OR invoice_matches.decision='auto' RETURNING *`,
      [userId,invoiceId,
        best && !isRazorpay && status !== 'unmatched' ? best.id : null,
        best && isRazorpay && status !== 'unmatched' ? best.id : null,
        best?.score ?? 0,best?.percentage ?? 0,status,JSON.stringify(reasons),decisionType,scanRunId,replaceManual]);
    const row = result.rows[0] ?? (await client.query('SELECT * FROM invoice_matches WHERE invoice_id=$1 AND user_id=$2',[invoiceId,userId])).rows[0];
    await client.query('COMMIT');
    return { ...row, invoiceId, txnId: row.paypal_transaction_id ?? row.razorpay_payment_id, provider: row.paypal_transaction_id ? 'paypal' : row.razorpay_payment_id ? 'razorpay' : null };
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
export async function setManualMatch(userId: string, invoiceId: string, transactionId: string | null) {
  const invoice = await getInvoice(userId,invoiceId);
  if (!transactionId) return persist(userId,invoiceId,null,'unmatched',['Unmatched manually; automatic scans will preserve this decision'],'manual');
  const txns = await transactions(userId);
  const txn = txns.find(t => t.id === transactionId);
  if (!txn) throw new Error('Payment not found');
  const best = { ...txn,...scoreMatch(invoice,txn) };
  if (!best.eligible) throw new Error('Only completed invoice payments can be matched');
  return persist(userId,invoiceId,best,'matched',[...best.reasons,...best.conflicts,'Chosen manually'], 'manual');
}
export function invoiceRange(invoice: InvoiceRow) {
  const end = new Date();
  const lookbackDays = Math.max(config.paypal.lookbackDays, config.razorpay.enabled ? config.razorpay.lookbackDays : 0);
  const normalStart = new Date(end.getTime()-lookbackDays*86400000);
  const date = invoice.invoice_date ? new Date(invoice.invoice_date).getTime() : NaN;
  if (Number.isFinite(date) && date < normalStart.getTime()) return {start:new Date(date-7*86400000),end:new Date(Math.min(end.getTime(),date+30*86400000))};
  return {start:normalStart,end};
}
export async function matchSingleInvoice(userId: string, invoiceId: string, scanRunId: string | null = null, resetManual = false) {
  const invoice = await getInvoice(userId,invoiceId);
  let candidates = ranked(invoice,await transactions(userId));
  if (!candidates.some(c => c.eligible && (c.identifierRank >= 2 || (c.amountExact && c.currencyExact) || (c.emailExact && c.score >= 35)))) {
    const range = invoiceRange(invoice);
    await syncInvoicePayments(userId,range);
    candidates = ranked(invoice,await transactions(userId));
  }
  const d = decision(candidates,invoiceId);
  return persist(userId,invoiceId,d.best,d.status,d.reasons,'auto',scanRunId,resetManual);
}
/** Index scoring signals; date/amount are alternatives, so an identifier
 * match outside the usual date window still reaches scoreMatch. */
export function candidateLookup(txns: TxnRow[]): (invoice: InvoiceRow) => TxnRow[] {
  const currencies = new Map<string, Set<TxnRow>>(), emails = new Map<string, Set<TxnRow>>();
  const identifiers = new Map<string, Set<TxnRow>>(), grams = new Map<string, Set<TxnRow>>();
  const amounts: { value: number; txn: TxnRow }[] = [], dates: { value: number; txn: TxnRow }[] = [];
  const descriptions = new Map<TxnRow, string[]>();
  const fold = (v: string) => v.toUpperCase().toLowerCase();
  const add = (map: Map<string, Set<TxnRow>>, key: string, txn: TxnRow) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(txn);
  };
  for (const txn of txns) {
    add(currencies, normalize(txn.currency), txn); add(emails, normalize(txn.payer_email), txn);
    if (txn.amount !== null && Number.isFinite(Number(txn.amount))) amounts.push({ value: Number(txn.amount), txn });
    const date = txn.transaction_initiated_at ? new Date(txn.transaction_initiated_at).getTime() : NaN;
    if (Number.isFinite(date)) dates.push({ value: date, txn });
    for (const id of fields(txn.raw_json, new Set(['invoice_id', 'invoice_number', 'custom_id', 'custom_field']))) {
      add(identifiers, normalize(id), txn);
    }
    const text = fields(txn.raw_json, new Set(['description', 'transaction_subject', 'transaction_note', 'note'])).map(fold);
    descriptions.set(txn, text);
    for (const value of text) for (let i = 0; i + 3 <= value.length; i++) add(grams, value.slice(i, i + 3), txn);
  }
  amounts.sort((a,b) => a.value-b.value); dates.sort((a,b) => a.value-b.value);
  const range = (sorted: typeof amounts, value: number, tolerance: number, out: Set<TxnRow>) => {
    if (!Number.isFinite(value)) return;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo+hi) >>> 1; if (sorted[mid].value < value-tolerance) lo=mid+1; else hi=mid; }
    for (let i=lo; i<sorted.length && sorted[i].value <= value+tolerance; i++) out.add(sorted[i].txn);
  };
  const eligible = (t: TxnRow) => t.provider === 'razorpay' ? (t.status || '').toLowerCase() === 'captured'
    : ['S','COMPLETED'].includes((t.status || '').toUpperCase()) && /^T00/.test(t.event_code || '') &&
      !['T0008','T0014','T0015','T0016','T0017','T0020'].includes(t.event_code || '');
  // Currency-only candidates tie at 10 points; two representatives preserve
  // the winner and ambiguity runner-up. Additional signals use the full indexes.
  for (const [currency, entries] of currencies) currencies.set(currency,
    new Set([...entries].filter(eligible).sort((a,b) => a.id.localeCompare(b.id)).slice(0,2)));
  const fallback = txns.filter(eligible).sort((a,b) => a.id.localeCompare(b.id)).slice(0,2);
  return invoice => {
    const out = new Set<TxnRow>(fallback);
    const include = (set?: Set<TxnRow>) => { if (set) for (const txn of set) out.add(txn); };
    include(currencies.get(normalize(invoice.currency))); include(emails.get(normalize(invoice.payer_email)));
    range(amounts, invoice.amount === null ? NaN : Number(invoice.amount), Math.max(1, config.matching.amountTolerance+1e-9), out);
    range(dates, invoice.invoice_date ? new Date(invoice.invoice_date).getTime() : NaN, Math.max(3, config.matching.dateToleranceDays)*86400000, out);
    const number = normalize(invoice.invoice_number);
    if (number) {
      include(identifiers.get(number)); include(identifiers.get(`invoice-sync:${number}`));
      const folded = fold(number);
      const possible = folded.length >= 3 ? grams.get(folded.slice(0,3)) ?? [] : txns;
      for (const txn of possible) if (descriptions.get(txn)?.some(text => text.includes(folded))) out.add(txn);
    }
    return [...out];
  };
}

export async function recomputeMatches(userId: string, scanRunId: string | null) {
  const { rows: invoices } = await query<InvoiceRow>("SELECT * FROM invoices WHERE user_id=$1 AND status='extracted' ORDER BY id",[userId]);
  // Release previous automatic reservations before recomputing all invoices together.
  // Manual decisions continue reserving their payments.
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[userId]);
    await client.query("UPDATE invoice_matches SET status='needs_review',updated_at=NOW() WHERE user_id=$1 AND decision='auto' AND status='matched'",[userId]);
    await client.query('COMMIT');
  } catch(err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  const txns = await transactions(userId, invoices.map(inv => inv.id));
  const lookup = candidateLookup(txns);
  const proposals = invoices.map(inv => ({ inv,...decision(ranked(inv,lookup(inv)),inv.id) }));
  const stats = { matched: 0, review: 0, unmatched: 0, created: 0 };
  const manual = await query<{invoice_id:string}>("SELECT invoice_id FROM invoice_matches WHERE user_id=$1 AND decision='manual'",[userId]);
  const manualIds = new Set(manual.rows.map(r=>r.invoice_id));
  const counts = new Map<string,number>();
  for (const p of proposals) if (!manualIds.has(p.inv.id) && p.best && p.status==='matched') counts.set(p.best.id,(counts.get(p.best.id) ?? 0)+1);
  for (const p of proposals) {
    if (p.best && (counts.get(p.best.id) ?? 0)>1 && p.status==='matched') { p.status='needs_review'; p.reasons.push('Multiple invoices compete for this payment'); }
    const result = await persist(userId,p.inv.id,p.best,p.status,p.reasons,'auto',scanRunId);
    if (result.status==='matched') stats.matched++; else if (result.status==='needs_review') stats.review++; else stats.unmatched++;
    stats.created++;
  }
  return stats;
}
