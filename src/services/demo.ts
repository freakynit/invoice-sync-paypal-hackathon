import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { logInfo } from '../utils/logger.js';

export const DEMO_EMAIL = config.demo.email.toLowerCase();
export const DEMO_FILE_PREFIX = 'demo-';

export function isDemoEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === DEMO_EMAIL;
}

export async function isDemoUser(userId: string): Promise<boolean> {
  const { rows } = await query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [userId]);
  const email = rows[0]?.email ?? '';
  return isDemoEmail(email);
}

export function isDemoFileId(driveFileId: string | null | undefined): boolean {
  return typeof driveFileId === 'string' && driveFileId.startsWith(DEMO_FILE_PREFIX);
}

interface DemoInvoiceSeed {
  fileId: string;
  fileName: string;
  invoiceNumber: string | null;
  vendor: string | null;
  amount: number | null;
  currency: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  payerEmail: string | null;
  description: string | null;
}

interface DemoPaymentSeed {
  transactionId: string;
  referenceId: string | null;
  eventCode: string;
  status: string;
  amount: number | null;
  currency: string | null;
  payerEmail: string | null;
  payerName: string | null;
  initiatedAt: string;
  invoiceRef: string | null;
  customRef: string | null;
  note: string | null;
}

// Curated demo workspace: Acme-heavy so "Which Acme invoices are overdue?"
// works out of the box, plus duplicate / overpayment / currency-conflict flags.
const DEMO_INVOICES: DemoInvoiceSeed[] = [
  { fileId: 'demo-acme-2041', fileName: 'ACME-INV-2041.pdf', invoiceNumber: 'ACME-INV-2041', vendor: 'Acme Studio', amount: 1240.0, currency: 'USD', invoiceDate: '2026-09-12', dueDate: '2026-09-26', payerEmail: 'accounts@acme.test', description: 'Design retainer September' },
  { fileId: 'demo-acme-2042', fileName: 'ACME-INV-2042.pdf', invoiceNumber: 'ACME-INV-2042', vendor: 'Acme Studio', amount: 860.5, currency: 'USD', invoiceDate: '2026-09-14', dueDate: '2026-09-28', payerEmail: 'accounts@acme.test', description: 'Additional illustrations' },
  { fileId: 'demo-acme-2043', fileName: 'ACME-INV-2043.pdf', invoiceNumber: 'ACME-INV-2043', vendor: 'Acme Studio', amount: 412.0, currency: 'EUR', invoiceDate: '2026-09-18', dueDate: '2026-09-20', payerEmail: 'accounts@acme.test', description: 'Overdue EU invoice (currency conflict demo)' },
  { fileId: 'demo-acme-2044', fileName: 'ACME-INV-2044.pdf', invoiceNumber: 'ACME-INV-2044', vendor: 'Acme Studio', amount: 980.0, currency: 'USD', invoiceDate: '2026-08-02', dueDate: '2026-08-16', payerEmail: 'accounts@acme.test', description: 'Overdue August invoice, no payment yet' },
  { fileId: 'demo-bright-3101', fileName: 'BRIGHT-3101.pdf', invoiceNumber: 'BRIGHT-3101', vendor: 'Brightline Co', amount: 860.5, currency: 'USD', invoiceDate: '2026-09-14', dueDate: '2026-10-14', payerEmail: 'pay@brightline.test', description: 'Competing amount with ACME-2042 (ambiguity demo)' },
  { fileId: 'demo-north-778', fileName: 'NORTH-778.pdf', invoiceNumber: null, vendor: 'Northwind', amount: 412.0, currency: 'EUR', invoiceDate: '2026-09-18', dueDate: null, payerEmail: null, description: 'Missing invoice number' },
  { fileId: 'demo-dupe-901', fileName: 'DUPE-INV-0901-a.pdf', invoiceNumber: 'DUPE-INV-0901', vendor: 'Dupe Supplies', amount: 250.0, currency: 'USD', invoiceDate: '2026-09-10', dueDate: '2026-09-24', payerEmail: 'ap@dupe.test', description: 'First copy of duplicate invoice' },
  { fileId: 'demo-dupe-902', fileName: 'DUPE-INV-0901-b.pdf', invoiceNumber: 'DUPE-INV-0901', vendor: 'Dupe Supplies', amount: 250.0, currency: 'USD', invoiceDate: '2026-09-10', dueDate: '2026-09-24', payerEmail: 'ap@dupe.test', description: 'Second copy of duplicate invoice (duplicate flag)' },
  { fileId: 'demo-over-551', fileName: 'OVER-0551.pdf', invoiceNumber: 'OVER-0551', vendor: 'Overpay Inc', amount: 500.0, currency: 'USD', invoiceDate: '2026-09-11', dueDate: '2026-09-25', payerEmail: 'billing@overpay.test', description: 'Invoice paid 550 (overpayment demo)' },
  { fileId: 'demo-part-332', fileName: 'PART-0332.pdf', invoiceNumber: 'PART-0332', vendor: 'Partial LLC', amount: 1000.0, currency: 'USD', invoiceDate: '2026-09-09', dueDate: '2026-09-23', payerEmail: 'pay@partial.test', description: 'Partially paid 400 (underpayment demo)' },
  { fileId: 'demo-fx-771', fileName: 'FX-0771.pdf', invoiceNumber: 'FX-0771', vendor: 'Globex', amount: 700.0, currency: 'USD', invoiceDate: '2026-09-15', dueDate: '2026-09-29', payerEmail: 'ap@globex.test', description: 'Paid in EUR instead of USD (currency conflict)' },
  { fileId: 'demo-unpaid-999', fileName: 'UNPAID-0999.pdf', invoiceNumber: 'UNPAID-0999', vendor: 'Umbrella Corp', amount: 1999.99, currency: 'USD', invoiceDate: '2026-09-01', dueDate: '2026-09-15', payerEmail: 'finance@umbrella.test', description: 'Large overdue invoice with no payment' },
];

const DEMO_PAYMENTS: DemoPaymentSeed[] = [
  { transactionId: 'DEMO-TXN-ACME2041', referenceId: 'DEMO-REF-2041', eventCode: 'T0006', status: 'COMPLETED', amount: 1240.0, currency: 'USD', payerEmail: 'accounts@acme.test', payerName: 'Acme Studio', initiatedAt: '2026-09-13T10:00:00Z', invoiceRef: 'ACME-INV-2041', customRef: 'invoice-sync:acme-inv-2041', note: 'Payment for ACME-INV-2041' },
  { transactionId: 'DEMO-TXN-ACME2042', referenceId: 'DEMO-REF-2042', eventCode: 'T0006', status: 'COMPLETED', amount: 860.5, currency: 'USD', payerEmail: 'accounts@acme.test', payerName: 'Acme Studio', initiatedAt: '2026-09-15T10:00:00Z', invoiceRef: 'ACME-INV-2042', customRef: 'invoice-sync:acme-inv-2042', note: 'Payment for ACME-INV-2042' },
  { transactionId: 'DEMO-TXN-ACME2043-FX', referenceId: 'DEMO-REF-2043', eventCode: 'T0006', status: 'COMPLETED', amount: 412.0, currency: 'USD', payerEmail: 'accounts@acme.test', payerName: 'Acme Studio', initiatedAt: '2026-09-19T10:00:00Z', invoiceRef: 'ACME-INV-2043', customRef: null, note: 'Payment for ACME-INV-2043 in USD (invoice is EUR)' },
  { transactionId: 'DEMO-TXN-DUPE', referenceId: 'DEMO-REF-DUPE', eventCode: 'T0006', status: 'COMPLETED', amount: 250.0, currency: 'USD', payerEmail: 'ap@dupe.test', payerName: 'Dupe Supplies', initiatedAt: '2026-09-11T10:00:00Z', invoiceRef: 'DUPE-INV-0901', customRef: 'invoice-sync:dupe-inv-0901', note: 'Shared payment for DUPE-INV-0901' },
  { transactionId: 'DEMO-TXN-OVER', referenceId: 'DEMO-REF-OVER', eventCode: 'T0006', status: 'COMPLETED', amount: 550.0, currency: 'USD', payerEmail: 'billing@overpay.test', payerName: 'Overpay Inc', initiatedAt: '2026-09-12T10:00:00Z', invoiceRef: 'OVER-0551', customRef: null, note: 'Overpayment for OVER-0551' },
  { transactionId: 'DEMO-TXN-PART', referenceId: 'DEMO-REF-PART', eventCode: 'T0006', status: 'COMPLETED', amount: 400.0, currency: 'USD', payerEmail: 'pay@partial.test', payerName: 'Partial LLC', initiatedAt: '2026-09-10T10:00:00Z', invoiceRef: 'PART-0332', customRef: null, note: 'Partial payment for PART-0332' },
  { transactionId: 'DEMO-TXN-FX', referenceId: 'DEMO-REF-FX', eventCode: 'T0006', status: 'COMPLETED', amount: 700.0, currency: 'EUR', payerEmail: 'ap@globex.test', payerName: 'Globex', initiatedAt: '2026-09-16T10:00:00Z', invoiceRef: 'FX-0771', customRef: null, note: 'Payment for FX-0771 in EUR' },
  { transactionId: 'DEMO-TXN-PENDING', referenceId: 'DEMO-REF-PEND', eventCode: 'T0006', status: 'PENDING', amount: 1999.99, currency: 'USD', payerEmail: 'finance@umbrella.test', payerName: 'Umbrella Corp', initiatedAt: '2026-09-16T10:00:00Z', invoiceRef: 'UNPAID-0999', customRef: null, note: 'Pending payment for UNPAID-0999' },
];

export async function ensureDemoUser(): Promise<{ id: string; email: string }> {
  const existing = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE LOWER(email)=$1`, [DEMO_EMAIL]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, name, email_verified_at, updated_at) VALUES ($1, NULL, $2, NOW(), NOW()) RETURNING id, email`,
    [DEMO_EMAIL, config.demo.name],
  );
  return created.rows[0];
}

export async function seedDemoData(userId: string): Promise<{ invoices: number; payments: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    // Upsert demo invoices (idempotent on user_id + drive_file_id)
    for (const inv of DEMO_INVOICES) {
      const extracted = {
        invoice_number: inv.invoiceNumber,
        vendor: inv.vendor,
        amount: inv.amount,
        currency: inv.currency,
        invoice_date: inv.invoiceDate,
        due_date: inv.dueDate,
        payer_email: inv.payerEmail,
        description: inv.description,
      };
      await client.query(
        `INSERT INTO invoices (user_id, drive_file_id, drive_file_name, mime_type, drive_modified_time, drive_web_view_link, raw_text, extracted_json,
          invoice_number, vendor_name, amount, currency, invoice_date, due_date, payer_email, status, last_error, last_scanned_at, updated_at)
         VALUES ($1,$2,$3,'image/png',NOW(),NULL,NULL,$4,$5,$6,$7,$8,$9,$10,$11,'extracted',NULL,NOW(),NOW())
         ON CONFLICT (user_id, drive_file_id) DO UPDATE SET drive_file_name=EXCLUDED.drive_file_name,
           extracted_json=EXCLUDED.extracted_json, invoice_number=EXCLUDED.invoice_number, vendor_name=EXCLUDED.vendor_name,
           amount=EXCLUDED.amount, currency=EXCLUDED.currency, invoice_date=EXCLUDED.invoice_date, due_date=EXCLUDED.due_date,
           payer_email=EXCLUDED.payer_email, status='extracted', last_error=NULL, last_scanned_at=NOW(), updated_at=NOW()`,
        [userId, inv.fileId, inv.fileName, JSON.stringify(extracted), inv.invoiceNumber, inv.vendor, inv.amount, inv.currency, inv.invoiceDate, inv.dueDate, inv.payerEmail],
      );
    }
    // Upsert demo payments (idempotent on user_id + transaction id + initiated_at)
    for (const pay of DEMO_PAYMENTS) {
      const raw = {
        transaction_info: {
          transaction_id: pay.transactionId,
          paypal_reference_id: pay.referenceId,
          transaction_event_code: pay.eventCode,
          transaction_status: pay.status,
          transaction_amount: { value: pay.amount?.toFixed(2), currency_code: pay.currency },
          transaction_initiation_date: pay.initiatedAt,
        },
        payer_info: { email_address: pay.payerEmail, payer_name: { alternate_full_name: pay.payerName } },
        purchase_unit: { invoice_id: pay.invoiceRef, custom_id: pay.customRef },
        transaction_note: pay.note,
        description: pay.note,
        demo: true,
      };
      await client.query(
        `INSERT INTO paypal_transactions (user_id, paypal_transaction_id, paypal_reference_id, event_code, status, amount, currency, fee, payer_email, payer_name, transaction_initiated_at, transaction_updated_at, raw_json, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$10,$11,NOW())
         ON CONFLICT (user_id, paypal_transaction_id, transaction_initiated_at) DO UPDATE SET paypal_reference_id=EXCLUDED.paypal_reference_id,
           event_code=EXCLUDED.event_code, status=EXCLUDED.status, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
           payer_email=EXCLUDED.payer_email, payer_name=EXCLUDED.payer_name, raw_json=EXCLUDED.raw_json, updated_at=NOW()`,
        [userId, pay.transactionId, pay.referenceId, pay.eventCode, pay.status, pay.amount, pay.currency, pay.payerEmail, pay.payerName, pay.initiatedAt, JSON.stringify(raw)],
      );
    }
    // Ensure a demo drive connection row so the Drive tab shows "Demo" instead of "Not connected".
    await client.query(
      `INSERT INTO google_drive_connections (user_id, google_email, access_token, refresh_token, folders, folder_id, folder_name, updated_at)
       VALUES ($1,'demo@invoice-sync.local',NULL,NULL,'[{"id":"demo-root","name":"Demo Invoices"}]','demo-root','Demo Invoices',NOW())
       ON CONFLICT (user_id) DO UPDATE SET google_email=EXCLUDED.google_email, folders=EXCLUDED.folders, folder_id=EXCLUDED.folder_id, folder_name=EXCLUDED.folder_name, updated_at=NOW()`,
      [userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Recompute matches using the real matcher so percentages/reasons are authentic.
  const { recomputeMatches } = await import('./matching.js');
  const { rows } = await query<{ id: string }>(`SELECT id FROM scan_runs WHERE user_id=$1 AND trigger='demo-seed' ORDER BY started_at DESC LIMIT 1`, [userId]);
  let scanRunId: string | null = rows[0]?.id ?? null;
  if (!scanRunId) {
    const created = await query<{ id: string }>(`INSERT INTO scan_runs (user_id, trigger, status, current_stage) VALUES ($1,'demo-seed','success','done') RETURNING id`, [userId]);
    scanRunId = created.rows[0].id;
  }
  await recomputeMatches(userId, scanRunId);
  const counts = await query<{ invoices: string; payments: string }>(
    `SELECT (SELECT COUNT(*)::text FROM invoices WHERE user_id=$1) AS invoices, (SELECT COUNT(*)::text FROM paypal_transactions WHERE user_id=$1) AS payments`,
    [userId],
  );
  logInfo('Demo data seeded', { userId, ...counts.rows[0] });
  return { invoices: Number(counts.rows[0].invoices), payments: Number(counts.rows[0].payments) };
}

export async function resetDemoData(userId: string): Promise<{ invoices: number; payments: number }> {
  // Delete demo-seeded rows only (demo file ids / demo txn ids), keep user + manual pay-now rows.
  await query(`DELETE FROM invoice_matches WHERE user_id=$1`, [userId]);
  await query(`DELETE FROM invoices WHERE user_id=$1 AND drive_file_id LIKE 'demo-%'`, [userId]);
  await query(`DELETE FROM paypal_transactions WHERE user_id=$1 AND paypal_transaction_id LIKE 'DEMO-%'`, [userId]);
  return seedDemoData(userId);
}

/** Render a lightweight SVG placeholder for demo invoice originals (no Drive needed). */
export function renderDemoInvoiceSvg(invoice: {
  drive_file_name: string | null;
  invoice_number: string | null;
  vendor_name: string | null;
  amount: string | number | null;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
}): Buffer {
  const esc = (v: unknown): string => String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
<rect width="800" height="1000" fill="#ffffff"/>
<rect x="0" y="0" width="800" height="140" fill="#0B4F49"/>
<text x="48" y="62" font-family="Arial" font-size="30" font-weight="bold" fill="#ffffff">Invoice Sync · Demo invoice</text>
<text x="48" y="98" font-family="Arial" font-size="16" fill="#cde3dd">${esc(invoice.drive_file_name)} · no Drive keys needed</text>
<rect x="48" y="180" width="704" height="560" rx="16" fill="#F6F7FB" stroke="#E6E9F0"/>
<text x="80" y="240" font-family="Arial" font-size="22" font-weight="bold" fill="#0E1320">${esc(invoice.vendor_name ?? 'Vendor')}</text>
<text x="80" y="272" font-family="Arial" font-size="16" fill="#697386">${esc(invoice.invoice_number ?? 'No invoice number')}</text>
<text x="80" y="330" font-family="Arial" font-size="44" font-weight="bold" fill="#0E1320">${esc(invoice.currency ?? '')} ${esc(invoice.amount ?? '—')}</text>
<text x="80" y="380" font-family="Arial" font-size="16" fill="#3A4255">Invoice date: ${esc(invoice.invoice_date ?? '—')} · Due: ${esc(invoice.due_date ?? '—')}</text>
<text x="80" y="430" font-family="Arial" font-size="14" fill="#697386">This is a sample document to explore matching,</text>
<text x="80" y="452" font-family="Arial" font-size="14" fill="#697386">chat and Pay Now without PayPal / Drive keys.</text>
<text x="80" y="500" font-family="Arial" font-size="14" fill="#697386">Open the Extracted data tab to see the structured fields.</text>
<rect x="80" y="540" width="220" height="44" rx="10" fill="#0B4F49"/>
<text x="100" y="568" font-family="Arial" font-size="16" font-weight="bold" fill="#ffffff">DEMO · SEEDED</text>
</svg>`;
  return Buffer.from(svg, 'utf8');
}
