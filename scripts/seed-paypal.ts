#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import type { PaypalTransactionNormalized } from '../src/services/paypal.js';

// Official PayPal sandbox test card, never a real card. No card data is saved.
// https://developer.paypal.com/sandbox-testing/card-testing
const base = 'https://api-m.sandbox.paypal.com';
const args = process.argv.slice(2);
const resume = args.includes('--resume');
const newRun = args.includes('--new-run');
if (resume && newRun) throw new Error('Use either --resume or --new-run');
if (args.some(a => !['--resume', '--new-run', '--help'].includes(a))) throw new Error('Usage: npm run seed:paypal -- [--resume | --new-run]');
if (args.includes('--help')) { console.log('Create real sandbox test-card captures and a matching scenario manifest in sandbox-test-data. --resume continues the saved run without repeating completed requests. --new-run explicitly starts another set of payments.'); process.exit(0); }
if (config.paypal.mode !== 'sandbox' || config.paypal.baseUrl.replace(/\/$/, '') !== base) throw new Error('This script only supports PayPal sandbox.');
if (!config.paypal.clientId || !config.paypal.clientSecret) throw new Error('Missing PayPal credentials in .env');

type Scenario = {
  case: string; invoiceNumber: string; amount: number; currency: string; invoiceDate: string;
  payerEmail: string | null; expected: 'matched' | 'needs_review' | 'unmatched'; reason: string;
  payments: { unit: Record<string, unknown>; mode?: 'declined' | 'unapproved'; order?: any; error?: unknown; requestId: string }[];
};
type Manifest = { run: string; createdAt: string; scenarios: Scenario[]; transactions: PaypalTransactionNormalized[] };
const dir = path.resolve('sandbox-test-data');
const file = path.join(dir, 'manifest.json');
await mkdir(dir, { recursive: true });
let manifest: Manifest;
if (resume) manifest = JSON.parse(await readFile(file, 'utf8'));
else {
  const existing = await readFile(file, 'utf8').catch(() => null);
  if (existing && !newRun) throw new Error('A saved run exists. Use --resume, or --new-run to create another set of payments.');
  if (existing) { const previous = JSON.parse(existing); await writeFile(path.join(dir, `${previous.run}.json`), existing); }
  // Reuse the first successful capability probe, if present.
  const probe = newRun ? null : await readFile(path.join(dir, 'probe.json'), 'utf8').then(JSON.parse).catch(() => null);
  const run = probe?.run ?? `MATCH-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  const scenarios: Scenario[] = [];
  const add = (name: string, expected: Scenario['expected'], reason: string, kind = 'invoice', changes: Partial<Scenario> = {}, paymentCount = 1) => {
    const i = scenarios.length + 1, invoiceNumber = `${run}-${String(i).padStart(2, '0')}`;
    const amount = Number((10 + i * 1.13).toFixed(2));
    const s: Scenario = { case: name, invoiceNumber, amount, currency: 'USD', invoiceDate: today, payerEmail: null, expected, reason, payments: [], ...changes };
    for (let n = 0; n < paymentCount; n++) {
      const unit: Record<string, unknown> = { description: `Sandbox matching case: ${name}`, amount: { currency_code: 'USD', value: amount.toFixed(2) } };
      if (kind === 'invoice') unit.invoice_id = invoiceNumber;
      if (kind === 'custom') unit.custom_id = `invoice-sync:${invoiceNumber}`;
      if (kind === 'description') unit.description = `Payment for ${invoiceNumber}`;
      s.payments.push({ unit, requestId: `${run}-${i}-${n}` });
    }
    scenarios.push(s); return s;
  };
  const exact = add('exact-invoice', 'matched', 'Structured invoice number, exact total and currency; absent email is allowed.');
  if (probe?.order?.status === 'COMPLETED') exact.payments[0].order = probe.order;
  add('custom-id', 'matched', 'Exact invoice-sync custom identifier, amount and currency.', 'custom');
  add('description-only', 'needs_review', 'Description mention has no strong identifier or matching payer email.', 'description');
  add('amount-tolerance', 'matched', 'One cent difference is inside the configured amount tolerance.', 'invoice', { amount: Number((14.52 + config.matching.amountTolerance).toFixed(2)) });
  add('near-amount', 'needs_review', '50 cent total difference requires manual review.', 'invoice', { amount: 16.15 });
  add('partial-payment', 'needs_review', 'Invoice total is twice the captured payment.', 'invoice', { amount: 33.56 });
  add('overpayment', 'needs_review', 'Payment exceeds the invoice total.', 'invoice', { amount: 8.91 });
  add('currency-conflict', 'needs_review', 'USD capture versus EUR invoice.', 'invoice', { currency: 'EUR' });
  const wrong = add('invoice-number-conflict', 'needs_review', 'Exact custom identifier but conflicting structured invoice number.', 'custom');
  wrong.payments[0].unit.invoice_id = `${run}-OTHER`;
  add('ambiguous-payments', 'needs_review', 'Two equally strong completed payments; choose manually.', 'custom', {}, 2);
  add('old-date-with-identifier', 'matched', 'Exact structured identifier can match outside the date tolerance.', 'invoice', { invoiceDate: new Date(Date.now() - (config.matching.dateToleranceDays + 10) * 86400000).toISOString().slice(0, 10) });
  add('unpaid', 'unmatched', 'No payment; a unique high total and old date avoid weak nearby candidates.', 'none', { amount: 9876.54, invoiceDate: '2025-01-01' }, 0);
  const pending = add('unapproved-order', 'unmatched', 'Created order has no capture and is not a completed transaction.');
  pending.payments[0].mode = 'unapproved';
  const declined = add('declined-card', 'unmatched', 'PayPal sandbox rejection trigger produces no eligible completed payment.');
  declined.payments[0].mode = 'declined';
  add('missing-email-and-due-date', 'matched', 'Optional invoice fields do not prevent a strong structured match.');
  const shared = add('shared-payment-first', 'needs_review', 'Two invoices compete for the same payment; one payment can only be assigned once.');
  scenarios.push({ ...shared, case: 'shared-payment-second', payments: [], reason: shared.reason });
  manifest = { run, createdAt: new Date().toISOString(), scenarios, transactions: [] };
}
const save = () => writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
await save();
const auth = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(config.paypal.timeoutMs) });
if (!auth.ok) throw new Error(`PayPal sandbox OAuth failed (${auth.status})`);
const { access_token: token } = await auth.json() as { access_token: string };
let failures = 0;
for (const scenario of manifest.scenarios) {
  for (const payment of scenario.payments) {
    if (!payment.order) {
      const body: any = { intent: 'CAPTURE', purchase_units: [payment.unit] };
      if (payment.mode !== 'unapproved') body.payment_source = { card: { number: '4012888888881881', expiry: `${new Date().getUTCFullYear() + 4}-12`, security_code: '123', name: payment.mode === 'declined' ? 'CCREJECT-REFUSED' : 'Invoice Sync Tester', billing_address: { address_line_1: '123 Test Street', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } } };
      const res = await fetch(base + '/v2/checkout/orders', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': payment.requestId }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.paypal.timeoutMs) });
      const data: any = await res.json();
      if (!res.ok) {
        payment.error = { httpStatus: res.status, name: data.name, details: data.details };
        const expectedDecline = payment.mode === 'declined' && data.details?.some((d: any) => d.issue === 'INSTRUMENT_DECLINED');
        if (!expectedDecline) failures++;
        await save(); console.log(`${scenario.case}: ${data.name} (${res.status})${expectedDecline ? ' [expected decline]' : ''}`); continue;
      }
      payment.order = data;
      delete payment.error;
      await save(); // Save provider response immediately for resumability.
    }
    const order = payment.order;
    const captures = order.purchase_units?.[0]?.payments?.captures ?? [];
    if (!payment.mode && (!captures.length || captures.some((c: any) => c.status !== 'COMPLETED'))) {
      console.error(`${scenario.case}: expected a completed capture; actual order status ${order.status}`);
      failures++;
    }
    if (payment.mode === 'declined' && !captures.some((c: any) => c.status === 'DECLINED')) {
      console.error(`${scenario.case}: expected a declined capture`);
      failures++;
    }
    for (const cap of order.purchase_units?.[0]?.payments?.captures ?? []) {
      if (manifest.transactions.some(t => t.transactionId === cap.id)) continue;
      manifest.transactions.push({ transactionId: cap.id, referenceId: order.id, eventCode: 'T0006', status: cap.status, amount: Number(cap.amount.value), currency: cap.amount.currency_code, fee: cap.seller_receivable_breakdown?.paypal_fee ? Number(cap.seller_receivable_breakdown.paypal_fee.value) : null, payerEmail: order.payer?.email_address ?? null, payerName: order.payment_source?.card?.name ?? null, initiatedAt: cap.create_time, updatedAt: cap.update_time, raw: { order: { id: order.id, ...payment.unit }, capture: cap } });
    }
    await save();
    console.log(`${scenario.case}: ${order.id} ${captures.length ? captures.map((c: any) => c.status).join(', ') : order.status} → ${scenario.expected}`);
  }
}
console.log(`Saved ${manifest.transactions.length} real capture records and ${manifest.scenarios.length} invoice cases to ${file}`);
if (failures) process.exitCode = 1;
