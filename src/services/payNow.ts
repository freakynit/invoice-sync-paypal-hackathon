import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { isDemoUser } from './demo.js';
import { upsertPaypalTransactions } from './paypal.js';
import { logInfo } from '../utils/logger.js';

export interface PayNowRequest {
  method: 'order' | 'payout';
  receiverEmail?: string;
}

export interface PayNowResult {
  mode: 'live' | 'demo-simulated';
  method: 'order' | 'payout';
  orderId: string | null;
  batchId: string | null;
  approvalUrl: string | null;
  status: string;
  amount: number;
  currency: string;
  invoiceNumber: string | null;
  payNowId: string;
  message: string;
}

async function getInvoiceForPay(userId: string, invoiceId: string) {
  const { rows } = await query<{
    id: string; invoice_number: string | null; vendor_name: string | null; amount: string | null; currency: string | null; payer_email: string | null;
  }>(`SELECT id, invoice_number, vendor_name, amount, currency, payer_email FROM invoices WHERE id=$1 AND user_id=$2`, [invoiceId, userId]);
  const inv = rows[0];
  if (!inv) throw new Error('Invoice not found');
  const amount = inv.amount === null ? NaN : Number(inv.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invoice has no payable amount. Re-extract it first.');
  if (!inv.currency) throw new Error('Invoice has no currency. Re-extract it first.');
  return { ...inv, amount, currency: inv.currency.toUpperCase() };
}

async function recordPayNowAttempt(userId: string, invoiceId: string, method: string, data: Partial<{ orderId: string | null; batchId: string | null; approvalUrl: string | null; status: string; amount: number; currency: string; receiverEmail: string | null; raw: unknown }>): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO pay_now_orders (user_id, invoice_id, method, order_id, batch_id, approval_url, status, amount, currency, receiver_email, raw_json, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING id`,
    [userId, invoiceId, method, data.orderId ?? null, data.batchId ?? null, data.approvalUrl ?? null, data.status ?? 'created', data.amount ?? null, data.currency ?? null, data.receiverEmail ?? null, JSON.stringify(data.raw ?? {})],
  );
  return rows[0].id;
}

export async function createPayNow(userId: string, invoiceId: string, req: PayNowRequest): Promise<PayNowResult> {
  const inv = await getInvoiceForPay(userId, invoiceId);
  const method = req.method === 'payout' ? 'payout' : 'order';
  const demo = await isDemoUser(userId);

  if (demo) {
    // Simulate a PayPal payment instantly: store a COMPLETED demo transaction so matching reflects it.
    const txnId = `DEMO-PAYNOW-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date().toISOString();
    const raw = {
      transaction_info: {
        transaction_id: txnId,
        transaction_event_code: 'T0006',
        transaction_status: 'COMPLETED',
        transaction_amount: { value: inv.amount.toFixed(2), currency_code: inv.currency },
        transaction_initiation_date: now,
      },
      payer_info: { email_address: inv.payer_email ?? 'demo@invoice-sync.local' },
      purchase_unit: { invoice_id: inv.invoice_number, custom_id: inv.invoice_number ? `invoice-sync:${inv.invoice_number.toLowerCase()}` : null },
      pay_now: { method, invoice_id: invoiceId, simulated: true },
      demo: true,
    };
    await upsertPaypalTransactions(userId, [{
      transactionId: txnId,
      referenceId: method === 'order' ? `DEMO-ORDER-${randomUUID().slice(0, 8)}` : null,
      eventCode: 'T0006',
      status: 'COMPLETED',
      amount: inv.amount,
      currency: inv.currency,
      fee: null,
      payerEmail: inv.payer_email,
      payerName: inv.vendor_name,
      initiatedAt: now,
      updatedAt: now,
      raw,
    }]);
    const payNowId = await query<{ id: string }>(
      `INSERT INTO pay_now_orders (user_id, invoice_id, method, order_id, batch_id, approval_url, status, amount, currency, receiver_email, raw_json, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'captured',$7,$8,$9,$10,NOW()) RETURNING id`,
      [userId, invoiceId, method, method === 'order' ? txnId : null, method === 'payout' ? txnId : null, null, inv.amount, inv.currency, req.receiverEmail?.trim() ?? inv.payer_email, JSON.stringify({ simulated: true, transactionId: txnId })],
    ).then((r) => r.rows[0].id);
    // Re-score this invoice so the dashboard shows Matched immediately.
    const { matchSingleInvoice } = await import('./matching.js');
    await matchSingleInvoice(userId, invoiceId, null, true).catch(() => {});
    logInfo('Demo Pay Now simulated', { userId, invoiceId, txnId });
    return {
      mode: 'demo-simulated', method, orderId: method === 'order' ? txnId : null, batchId: method === 'payout' ? txnId : null,
      approvalUrl: null, status: 'captured', amount: inv.amount, currency: inv.currency, invoiceNumber: inv.invoice_number,
      payNowId, message: `Demo payment simulated: ${inv.currency} ${inv.amount.toFixed(2)} marked as paid (no PayPal keys needed).`,
    };
  }

  if (method === 'payout') {
    const receiver = (req.receiverEmail ?? inv.payer_email ?? '').trim();
    if (!receiver || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(receiver)) {
      throw new Error('A receiver email is required for payouts (invoice has no payer email — pass receiverEmail).');
    }
    const { createPayoutSeed } = await import('./paypalSeed.js');
    const result = await createPayoutSeed(userId, [{
      invoiceId: inv.invoice_number ?? inv.id.slice(0, 12),
      amount: inv.amount,
      currency: inv.currency,
      description: `Pay Now for ${inv.invoice_number ?? 'invoice'} (${inv.vendor_name ?? ''})`,
    }], receiver);
    const payNowId = await recordPayNowAttempt(userId, invoiceId, method, {
      batchId: result.batchId, status: result.batchStatus, amount: inv.amount, currency: inv.currency, receiverEmail: receiver, raw: result,
    });
    return {
      mode: 'live', method, orderId: null, batchId: result.batchId, approvalUrl: null, status: result.batchStatus,
      amount: inv.amount, currency: inv.currency, invoiceNumber: inv.invoice_number, payNowId,
      message: `Payout batch ${result.batchStatus}. Run Scan in a few minutes to pull it via Transaction Search.`,
    };
  }

  const { createSeedOrders } = await import('./paypalSeed.js');
  const orders = await createSeedOrders(userId, [{
    invoiceId: inv.invoice_number ?? inv.id.slice(0, 12),
    amount: inv.amount,
    currency: inv.currency,
    description: `Pay Now for ${inv.invoice_number ?? 'invoice'} (${inv.vendor_name ?? ''})`,
  }]);
  const order = orders[0];
  const payNowId = await recordPayNowAttempt(userId, invoiceId, method, {
    orderId: order.orderId, approvalUrl: order.approvalUrl, status: order.status, amount: inv.amount, currency: inv.currency, raw: order,
  });
  return {
    mode: 'live', method, orderId: order.orderId, batchId: null, approvalUrl: order.approvalUrl, status: order.status,
    amount: inv.amount, currency: inv.currency, invoiceNumber: inv.invoice_number, payNowId,
    message: order.approvalUrl
      ? `Order created. Approve as a sandbox buyer, then Capture to store the payment.`
      : `Order ${order.orderId} created with status ${order.status}.`,
  };
}

export async function capturePayNow(userId: string, invoiceId: string, orderId: string): Promise<{ stored: number; status: string }> {
  if (await isDemoUser(userId)) throw new Error('Demo payments are already captured (simulated).');
  const { captureSeedOrder } = await import('./paypalSeed.js');
  const result = await captureSeedOrder(userId, orderId);
  await query(`UPDATE pay_now_orders SET status='captured', updated_at=NOW() WHERE user_id=$1 AND invoice_id=$2 AND order_id=$3`, [userId, invoiceId, orderId]);
  const { matchSingleInvoice } = await import('./matching.js');
  await matchSingleInvoice(userId, invoiceId, null, true).catch(() => {});
  return { stored: result.stored, status: 'captured' };
}

export async function listPayNowOrders(userId: string, invoiceId?: string): Promise<unknown[]> {
  const { rows } = await query(
    invoiceId
      ? `SELECT * FROM pay_now_orders WHERE user_id=$1 AND invoice_id=$2 ORDER BY created_at DESC LIMIT 20`
      : `SELECT p.*, i.invoice_number, i.vendor_name FROM pay_now_orders p LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.user_id=$1 ORDER BY p.created_at DESC LIMIT 50`,
    invoiceId ? [userId, invoiceId] : [userId],
  );
  void config;
  return rows;
}
