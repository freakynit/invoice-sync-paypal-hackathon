import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { fetchRazorpayPayments, getRazorpayCreds, syncRazorpayPayments } from '../services/razorpay.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  if (!config.razorpay.enabled) { res.status(404).json({ error: 'Razorpay is disabled.' }); return; }
  next();
});

router.get('/status', async (req: AuthedRequest, res) => {
  const { rows } = await query<{ key_id: string | null }>(`SELECT key_id FROM razorpay_connections WHERE user_id=$1`, [req.userId]);
  const row = rows[0];
  const effectiveKeyId = row?.key_id || config.razorpay.keyId;
  const hasOwnCreds = Boolean(row?.key_id);
  res.json({
    configured: Boolean(effectiveKeyId && (hasOwnCreds || config.razorpay.keySecret)),
    linked: hasOwnCreds,
    linkType: hasOwnCreds ? 'credentials' : null,
    keyId: effectiveKeyId || null,
    hasSecret: hasOwnCreds ? true : Boolean(config.razorpay.keySecret),
    usingGlobalCreds: !hasOwnCreds,
    lookbackDays: config.razorpay.lookbackDays,
  });
});

const saveSchema = z.object({
  keyId: z.string().trim().min(5).max(255),
  keySecret: z.string().trim().min(5).max(255),
});

router.put('/credentials', async (req: AuthedRequest, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'keyId and keySecret are required.' });
    return;
  }
  await query(
    `INSERT INTO razorpay_connections (user_id, key_id, key_secret, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id) DO UPDATE SET key_id=EXCLUDED.key_id, key_secret=EXCLUDED.key_secret, updated_at=NOW()`,
    [req.userId, parsed.data.keyId.trim(), parsed.data.keySecret.trim()],
  );
  res.json({ message: 'Razorpay credentials saved', keyId: parsed.data.keyId.trim() });
});

router.delete('/credentials', async (req: AuthedRequest, res) => {
  await query(`DELETE FROM razorpay_connections WHERE user_id=$1`, [req.userId]);
  res.json({ message: 'Per-user Razorpay credentials removed (falls back to server config).' });
});

// Full unlink: drop per-user credentials.
router.delete('/disconnect', async (req: AuthedRequest, res) => {
  await query(`DELETE FROM razorpay_connections WHERE user_id=$1`, [req.userId]);
  res.json({ message: 'Razorpay account disconnected.' });
});

router.get('/test', async (req: AuthedRequest, res) => {
  try {
    await getRazorpayCreds(req.userId!);
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    const payments = await fetchRazorpayPayments(req.userId!, start, end);
    res.json({ ok: true, sampleCount: payments.length, sample: payments.slice(0, 3) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/payments', async (req: AuthedRequest, res) => {
  const requestedLimit = Number(req.query.limit ?? 50);
  const requestedOffset = Number(req.query.offset ?? 0);
  const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, Math.floor(requestedLimit))) : 50;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
  const { rows } = await query(`SELECT * FROM razorpay_payments WHERE user_id=$1 ORDER BY transaction_initiated_at DESC NULLS LAST LIMIT $2 OFFSET $3`, [
    req.userId,
    limit,
    offset,
  ]);
  const { rows: countRows } = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM razorpay_payments WHERE user_id=$1`, [req.userId]);
  res.json({ payments: rows, total: Number(countRows[0].count) });
});

// Force a re-fetch of the lookback window (used by the "sync" action in the UI).
router.post('/sync', async (req: AuthedRequest, res) => {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - config.razorpay.lookbackDays * 86400000);
    const fetched = await syncRazorpayPayments(req.userId!, start, end);
    res.json({ fetched, message: fetched ? `Updated ${fetched} Razorpay payment record(s)` : 'Razorpay cache is up to date' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
