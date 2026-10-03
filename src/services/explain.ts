import { query } from '../db/pool.js';

export interface InvoiceExplainerInput {
  id: string;
  invoice_number: string | null;
  vendor_name: string | null;
  amount: string | number | null;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
  payer_email: string | null;
  match_status: string | null;
  match_score: number | null;
  match_percentage: number | null;
  match_decision: string | null;
  match_reasons: unknown;
  matched_txn_id: string | null;
  matched_amount: string | number | null;
  matched_currency: string | null;
  matched_txn_date: string | null;
  matched_txn_payer: string | null;
  matched_txn_provider: string | null;
}

function parseReasons(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [raw];
    }
  }
  return [];
}

export interface InvoiceFlag {
  code: 'duplicate' | 'overpayment' | 'underpayment' | 'currency_conflict' | 'ambiguous' | 'overdue_unpaid' | 'missing_identifier' | 'pending_payment';
  label: string;
  detail: string;
}

export interface InvoiceExplanation {
  headline: string;
  summary: string;
  signals: string[];
  conflicts: string[];
  flags: InvoiceFlag[];
  overdue: boolean;
  daysOverdue: number | null;
}

function daysBetween(a: string | null, today: Date): number | null {
  if (!a) return null;
  const d = new Date(a).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.floor((today.getTime() - d) / 86400000);
}

export async function explainInvoice(userId: string, invoiceId: string): Promise<InvoiceExplanation & { invoice: InvoiceExplainerInput }> {
  const { rows } = await query<InvoiceExplainerInput>(
    `SELECT i.id, i.invoice_number, i.vendor_name, i.amount, i.currency, i.invoice_date, i.due_date, i.payer_email,
      m.status AS match_status, m.score AS match_score, m.percentage AS match_percentage, m.decision AS match_decision, m.reasons AS match_reasons,
      COALESCE(t.paypal_transaction_id, r.razorpay_payment_id) AS matched_txn_id,
      COALESCE(t.amount, r.amount) AS matched_amount, COALESCE(t.currency, r.currency) AS matched_currency,
      COALESCE(t.transaction_initiated_at, r.transaction_initiated_at) AS matched_txn_date,
      COALESCE(t.payer_email, r.payer_email) AS matched_txn_payer,
      CASE WHEN t.id IS NOT NULL THEN 'paypal' WHEN r.id IS NOT NULL THEN 'razorpay' END AS matched_txn_provider
     FROM invoices i LEFT JOIN invoice_matches m ON m.invoice_id=i.id
     LEFT JOIN paypal_transactions t ON t.id=m.paypal_transaction_id
     LEFT JOIN razorpay_payments r ON r.id=m.razorpay_payment_id
     WHERE i.id=$1 AND i.user_id=$2`,
    [invoiceId, userId],
  );
  const invoice = rows[0];
  if (!invoice) throw new Error('Invoice not found');
  const reasons = parseReasons(invoice.match_reasons);
  const signals = reasons.filter((r) => !/differs|missing|cannot|not an eligible|already matched|is of unknown|multiple|compete/i.test(r));
  const conflicts = reasons.filter((r) => /differs|missing|cannot|not an eligible|already matched|is of unknown|multiple|compete/i.test(r));
  const flags: InvoiceFlag[] = [];
  const today = new Date();
  const daysOverdue = invoice.due_date ? daysBetween(invoice.due_date, today) : null;
  const overdue = daysOverdue !== null && daysOverdue > 0 && invoice.match_status !== 'matched';

  // Duplicate: same invoice number on 2+ invoices.
  if (invoice.invoice_number) {
    const dupes = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM invoices WHERE user_id=$1 AND invoice_number IS NOT NULL AND LOWER(TRIM(invoice_number))=LOWER(TRIM($2))`, [userId, invoice.invoice_number]);
    if (Number(dupes.rows[0].count) > 1) {
      flags.push({ code: 'duplicate', label: 'Flagged: duplicate', detail: `${dupes.rows[0].count} invoices share invoice number ${invoice.invoice_number}. Only one payment should be matched; the rest need manual review.` });
    }
  } else {
    flags.push({ code: 'missing_identifier', label: 'Flagged: missing invoice number', detail: 'No invoice number was extracted, so automatic matching relies on amount, currency, email and date only.' });
  }

  // Amount flags: overpayment / underpayment vs matched payment.
  const invAmt = invoice.amount === null ? NaN : Number(invoice.amount);
  const payAmt = invoice.matched_amount === null ? NaN : Number(invoice.matched_amount);
  if (Number.isFinite(invAmt) && Number.isFinite(payAmt)) {
    const diff = payAmt - invAmt;
    if (Math.abs(diff) > 0.011) {
      if (diff > 0) flags.push({ code: 'overpayment', label: 'Flagged: overpayment', detail: `Payment is ${diff.toFixed(2)} ${invoice.matched_currency ?? ''} higher than the invoice total.` });
      else flags.push({ code: 'underpayment', label: 'Flagged: partial / underpayment', detail: `Payment is ${Math.abs(diff).toFixed(2)} ${invoice.matched_currency ?? ''} lower than the invoice total; a second payment may be outstanding.` });
    }
  }
  if (invoice.currency && invoice.matched_currency && invoice.currency.toLowerCase() !== invoice.matched_currency.toLowerCase()) {
    flags.push({ code: 'currency_conflict', label: 'Flagged: currency conflict', detail: `Invoice is ${invoice.currency} but the linked payment is ${invoice.matched_currency}. Confirm the correct settlement currency.` });
  }
  if (/multiple|ambiguous|compete/i.test(reasons.join(' '))) {
    flags.push({ code: 'ambiguous', label: 'Flagged: ambiguous candidates', detail: 'Multiple similarly strong payments exist; automatic confirmation was withheld for manual review.' });
  }
  if (invoice.match_status === 'matched' && invoice.matched_txn_id && /pending/i.test(String(invoice.match_reasons))) {
    flags.push({ code: 'pending_payment', label: 'Flagged: pending payment', detail: 'The linked payment is not completed; funds have not settled yet.' });
  }
  if (overdue) {
    flags.push({ code: 'overdue_unpaid', label: 'Flagged: overdue & unpaid', detail: `Due ${invoice.due_date} (${daysOverdue} day(s) overdue) with status ${invoice.match_status ?? 'unmatched'}.` });
  }

  const pct = invoice.match_percentage ?? 0;
  const vendor = invoice.vendor_name ?? 'Invoice';
  const num = invoice.invoice_number ?? invoice.id.slice(0, 8);
  let headline: string;
  if (invoice.match_status === 'matched') {
    headline = `Matched ${pct}% because ${signals.slice(0, 3).join(', ') || 'amount, currency and invoice reference agree'}.`;
  } else if (invoice.match_status === 'needs_review') {
    headline = `${vendor} ${num} needs review at ${pct}% — ${conflicts.slice(0, 2).join('; ') || 'close but not conclusive'}.`;
  } else {
    headline = `${vendor} ${num} is unmatched${overdue ? ` and ${daysOverdue} day(s) overdue` : ''} — no eligible payment with matching signals.`;
  }
  const summary = [
    `Invoice ${invoice.invoice_number ?? '(no number)'} · ${vendor} · ${invoice.amount ?? '—'} ${invoice.currency ?? ''} · due ${invoice.due_date ?? '—'}.`,
    invoice.matched_txn_id
      ? `Linked ${invoice.matched_txn_provider ?? 'payment'} ${invoice.matched_txn_id} (${invoice.matched_amount ?? '—'} ${invoice.matched_currency ?? ''}).`
      : 'No linked payment.',
    invoice.match_decision === 'manual' ? 'Manual decision (preserved across scans).' : 'Automatic matching.',
  ].join(' ');

  return { headline, summary, signals, conflicts, flags, overdue, daysOverdue, invoice };
}
