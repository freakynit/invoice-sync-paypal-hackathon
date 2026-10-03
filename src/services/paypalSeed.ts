import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getPaypalCreds, upsertPaypalTransactions, type PaypalTransactionNormalized } from './paypal.js';
import { withRetries } from '../utils/retry.js';

export interface SeedItem {
  invoiceId: string;
  amount: number;
  currency: string;
  description?: string;
}

export interface SeedOrder {
  orderId: string;
  approvalUrl: string | null;
  status: string;
  invoiceId: string;
  amount: number;
  currency: string;
}

async function paypalFetch(creds: { baseUrl: string }, token: string, path: string, init?: RequestInit): Promise<unknown> {
  return withRetries({ maxRetries: 4, baseMs: 1000, maxMs: 15000, operationName: `PayPal ${path}` }, async () => {
    const res = await fetch(`${creds.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(config.paypal.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`PayPal ${path} failed (${res.status}): ${body.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res.json() as Promise<unknown>;
  });
}

async function accessToken(creds: { clientId: string; clientSecret: string; baseUrl: string }): Promise<string> {
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
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Create sandbox checkout orders (buyer-approval flow) for test invoices.
 * The buyer approves each order in the sandbox browser, then we capture it.
 * purchase_units carry invoice_id + custom_id so matching keys off them.
 */
export async function createSeedOrders(userId: string, items: SeedItem[]): Promise<SeedOrder[]> {
  const creds = await getPaypalCreds(userId);
  const token = await accessToken(creds);
  const out: SeedOrder[] = [];
  for (const item of items) {
    const data = (await paypalFetch(creds, token, '/v2/checkout/orders', {
      method: 'POST',
      headers: { 'PayPal-Request-Id': randomUUID() },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            invoice_id: item.invoiceId,
            custom_id: `invoice-sync:${item.invoiceId}`,
            description: item.description ?? `Test payment for ${item.invoiceId}`,
            amount: { currency_code: item.currency.toUpperCase(), value: item.amount.toFixed(2) },
          },
        ],
        application_context: {
          return_url: `${config.app.publicBaseUrl}/dashboard`,
          cancel_url: `${config.app.publicBaseUrl}/dashboard`,
          user_action: 'PAY_NOW',
        },
      }),
    })) as { id: string; status: string; links?: { rel: string; href: string }[] };
    out.push({
      orderId: data.id,
      approvalUrl: data.links?.find((l) => l.rel === 'approve')?.href ?? null,
      status: data.status,
      invoiceId: item.invoiceId,
      amount: item.amount,
      currency: item.currency.toUpperCase(),
    });
  }
  return out;
}

export interface PayoutSeedResult {
  batchId: string;
  batchStatus: string;
  senderBatchId: string;
  items: { senderItemId: string; receiver: string; amount: number; currency: string }[];
}

/**
 * One-click sandbox test payments via Payouts (no buyer approval needed).
 * Each item carries the invoice number as sender_item_id + note.
 * Note: payouts can take minutes to appear in Transaction Search — run Scan after.
 */
export async function createPayoutSeed(userId: string, items: SeedItem[], receiverEmail: string): Promise<PayoutSeedResult> {
  const creds = await getPaypalCreds(userId);
  const token = await accessToken(creds);
  const senderBatchId = `invoice-sync-${Date.now()}`;
  const data = (await paypalFetch(creds, token, '/v1/payments/payouts', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': randomUUID() },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: 'Invoice Sync sandbox test payment' },
      items: items.map((item) => ({
        recipient_type: 'EMAIL',
        amount: { value: item.amount.toFixed(2), currency: item.currency.toUpperCase() },
        receiver: receiverEmail,
        note: `Test payment for ${item.invoiceId}${item.description ? ` — ${item.description}` : ''}`,
        sender_item_id: item.invoiceId,
      })),
    }),
  })) as { batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header: { sender_batch_id: string } } };
  return {
    batchId: data.batch_header.payout_batch_id,
    batchStatus: data.batch_header.batch_status,
    senderBatchId: data.batch_header.sender_batch_header.sender_batch_id,
    items: items.map((item) => ({ senderItemId: item.invoiceId, receiver: receiverEmail, amount: item.amount, currency: item.currency.toUpperCase() })),
  };
}

export async function getSeedOrderStatus(userId: string, orderId: string): Promise<{ orderId: string; status: string; approvalUrl: string | null }> {
  const creds = await getPaypalCreds(userId);
  const token = await accessToken(creds);
  const data = (await paypalFetch(creds, token, `/v2/checkout/orders/${orderId}`, { method: 'GET' })) as {
    id: string;
    status: string;
    links?: { rel: string; href: string }[];
  };
  return { orderId: data.id, status: data.status, approvalUrl: data.links?.find((l) => l.rel === 'approve')?.href ?? null };
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Capture an APPROVED sandbox order and store each capture as a
 * paypal_transactions row immediately (no Transaction Search needed).
 */
export async function captureSeedOrder(userId: string, orderId: string): Promise<{ stored: number; transactions: PaypalTransactionNormalized[] }> {
  const creds = await getPaypalCreds(userId);
  const token = await accessToken(creds);

  const order = (await paypalFetch(creds, token, `/v2/checkout/orders/${orderId}`, { method: 'GET' })) as {
    id: string;
    status: string;
    payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
    purchase_units?: { invoice_id?: string; custom_id?: string }[];
  };
  if (order.status !== 'APPROVED') {
    throw new Error('Approve this order in a browser as a sandbox buyer before capturing it.');
  }

  const captureRes = (await paypalFetch(creds, token, `/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { 'PayPal-Request-Id': randomUUID() },
    body: '{}',
  })) as {
    id: string;
    status: string;
    payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
    purchase_units?: {
      invoice_id?: string;
      custom_id?: string;
      payments?: { captures?: { id: string; status: string; amount?: { currency_code?: string; value?: string }; create_time?: string; update_time?: string }[] };
    }[];
  };

  const payer = captureRes.payer ?? order.payer;
  const payerName = [payer?.name?.given_name, payer?.name?.surname].filter(Boolean).join(' ') || null;
  const txns: PaypalTransactionNormalized[] = [];
  for (const [unitIndex, unit] of (captureRes.purchase_units ?? []).entries()) {
    for (const cap of unit.payments?.captures ?? []) {
      txns.push({
        transactionId: cap.id,
        referenceId: captureRes.id,
        eventCode: 'T0006',
        status: cap.status,
        amount: toNumber(cap.amount?.value),
        currency: cap.amount?.currency_code ?? null,
        fee: null,
        payerEmail: payer?.email_address ?? null,
        payerName,
        initiatedAt: cap.create_time ?? null,
        updatedAt: cap.update_time ?? null,
        raw: { order: { id: captureRes.id, invoice_id: unit.invoice_id ?? order.purchase_units?.[unitIndex]?.invoice_id, custom_id: unit.custom_id ?? order.purchase_units?.[unitIndex]?.custom_id }, capture: cap },
      });
    }
  }
  if (txns.length === 0) throw new Error(`Capture of ${orderId} returned no captures (status ${captureRes.status}).`);
  const stored = await upsertPaypalTransactions(userId, txns);
  return { stored, transactions: txns };
}
