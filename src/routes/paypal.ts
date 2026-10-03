import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { clearPaypalCache, ensurePaypalCacheAccount, fetchPaypalTransactions, getPaypalCreds } from '../services/paypal.js';

import { logError } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

router.get('/status', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.json({
      configured: true, linked: true, linkType: 'demo', payerId: 'demo-payer',
      mode: 'sandbox', usingGlobalCreds: false, lookbackDays: config.paypal.lookbackDays, demo: true,
    });
    return;
  }
  const { rows } = await query<{ client_id: string | null; mode: string }>(`SELECT client_id, mode FROM paypal_connections WHERE user_id=$1`, [req.userId]);
  const row = rows[0];
  const effectiveClientId = row?.client_id || config.paypal.clientId;
  const { rows: userRows } = await query<{ paypal_payer_id: string | null }>(`SELECT paypal_payer_id FROM users WHERE id=$1`, [req.userId]);
  const payerId = userRows[0]?.paypal_payer_id ?? null;
  const hasOwnCreds = Boolean(row?.client_id);
  res.json({
    configured: Boolean(effectiveClientId && (row?.client_id ? true : config.paypal.clientSecret)),
    linked: hasOwnCreds || Boolean(payerId),
    linkType: hasOwnCreds ? 'credentials' : payerId ? 'paypal-login' : null,
    payerId,
    mode: row?.mode ?? config.paypal.mode,
    usingGlobalCreds: !row?.client_id,
    lookbackDays: config.paypal.lookbackDays,
    demo: false,
  });
});

const saveSchema = z.object({
  clientId: z.string().min(5).max(255),
  clientSecret: z.string().min(5).max(255),
  mode: z.enum(['sandbox', 'live']).default('sandbox'),
});

router.put('/credentials', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses simulated payments. Use a real account to connect PayPal.' });
    return;
  }
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'clientId and clientSecret are required.' });
    return;
  }
  const baseUrl = parsed.data.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  await query(
    `INSERT INTO paypal_connections (user_id, client_id, client_secret, mode, base_url, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (user_id) DO UPDATE SET client_id=EXCLUDED.client_id, client_secret=EXCLUDED.client_secret, mode=EXCLUDED.mode, base_url=EXCLUDED.base_url, updated_at=NOW()`,
    [req.userId, parsed.data.clientId.trim(), parsed.data.clientSecret.trim(), parsed.data.mode, baseUrl],
  );
  await ensurePaypalCacheAccount(req.userId!);
  res.json({ message: 'PayPal credentials saved', mode: parsed.data.mode, baseUrl });
});

router.delete('/credentials', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses simulated payments.' });
    return;
  }
  await query(`DELETE FROM paypal_connections WHERE user_id=$1`, [req.userId]);
  await clearPaypalCache(req.userId!);
  res.json({ message: 'Per-user PayPal credentials removed (falls back to server config).' });
});

// Full unlink: drop per-user credentials AND the linked PayPal identity.
router.delete('/disconnect', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses simulated payments.' });
    return;
  }
  await query(`DELETE FROM paypal_connections WHERE user_id=$1`, [req.userId]);
  await query(`UPDATE users SET paypal_payer_id=NULL, updated_at=NOW() WHERE id=$1`, [req.userId]);
  await clearPaypalCache(req.userId!);
  res.json({ message: 'PayPal account disconnected.' });
});

router.get('/test', async (req: AuthedRequest, res) => {
  try {
    await getPaypalCreds(req.userId!);
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    const txns = await fetchPaypalTransactions(req.userId!, start, end);
    res.json({ ok: true, sampleCount: txns.length, sample: txns.slice(0, 3) });
  } catch (err) {
    logError('PayPal request failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'PayPal request failed. Check your connection and order approval, then try again.' });
  }
});

router.get('/transactions', async (req: AuthedRequest, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const { rows } = await query(`SELECT * FROM paypal_transactions WHERE user_id=$1 ORDER BY transaction_initiated_at DESC NULLS LAST LIMIT $2 OFFSET $3`, [
    req.userId,
    limit,
    offset,
  ]);
  const { rows: countRows } = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM paypal_transactions WHERE user_id=$1`, [req.userId]);
  res.json({ transactions: rows, total: Number(countRows[0].count) });
});

// --- Sandbox test payments (programmatic test transactions) ---
// Creates real sandbox checkout orders carrying your invoice numbers.
// Flow: create → approve each link as a sandbox buyer → capture → stored.
const seedSchema = z.object({
  items: z
    .array(
      z.object({
        invoiceId: z.string().trim().min(1).max(127),
        amount: z.number().positive().max(100000),
        currency: z.string().trim().length(3).default('USD'),
        description: z.string().max(255).optional(),
      }),
    )
    .min(1)
    .max(10),
});

router.post('/seed/orders', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses simulated payments.' });
    return;
  }
  const parsed = seedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide items: [{ invoiceId, amount, currency?, description? }] (max 10).' });
    return;
  }
  try {
    const { createSeedOrders } = await import('../services/paypalSeed.js');
    const orders = await createSeedOrders(req.userId!, parsed.data.items);
    res.status(201).json({
      message: 'Sandbox orders created. Approve each link as a sandbox buyer, then Capture.',
      orders,
    });
  } catch (err) {
    logError('PayPal request failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'PayPal request failed. Check your connection and order approval, then try again.' });
  }
});

router.get('/seed/order', async (req: AuthedRequest, res) => {
  const orderId = String(req.query.orderId ?? '');
  if (!orderId) {
    res.status(400).json({ error: 'orderId query param is required.' });
    return;
  }
  try {
    const { getSeedOrderStatus } = await import('../services/paypalSeed.js');
    res.json(await getSeedOrderStatus(req.userId!, orderId));
  } catch (err) {
    logError('PayPal request failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'PayPal request failed. Check your connection and order approval, then try again.' });
  }
});

router.post('/seed/capture', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses simulated payments.' });
    return;
  }
  const parsed = z.object({ orderId: z.string().min(5) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'orderId is required.' });
    return;
  }
  try {
    const { captureSeedOrder } = await import('../services/paypalSeed.js');
    const result = await captureSeedOrder(req.userId!, parsed.data.orderId);
    res.json({ message: `Captured and stored ${result.stored} transaction(s).`, ...result });
  } catch (err) {
    logError('PayPal request failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'PayPal request failed. Check your connection and order approval, then try again.' });
  }
});

// One-click sandbox payouts (no buyer approval; USA accounts only).
const payoutSchema = z.object({
  receiverEmail: z.string().trim().email(),
  items: z
    .array(
      z.object({
        invoiceId: z.string().trim().min(1).max(127),
        amount: z.number().positive().max(100000),
        currency: z.string().trim().length(3).default('USD'),
        description: z.string().max(255).optional(),
      }),
    )
    .min(1)
    .max(15),
});

router.post('/seed/payouts', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses simulated payments.' });
    return;
  }
  const parsed = payoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide receiverEmail and items: [{ invoiceId, amount, currency?, description? }] (max 15).' });
    return;
  }
  try {
    const { createPayoutSeed } = await import('../services/paypalSeed.js');
    const result = await createPayoutSeed(req.userId!, parsed.data.items, parsed.data.receiverEmail.trim());
    res.status(201).json({
      message: `Payout batch ${result.batchStatus}. Run Scan in a few minutes to pull them via Transaction Search.`,
      ...result,
    });
  } catch (err) {
    logError('PayPal request failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'PayPal request failed. Check your connection and order approval, then try again.' });
  }
});

export default router;
