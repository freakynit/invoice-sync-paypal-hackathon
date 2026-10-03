#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { pool, query } from '../src/db/pool.js';
import { ensurePaypalCacheAccount, getPaypalCreds, upsertPaypalTransactions, type PaypalTransactionNormalized } from '../src/services/paypal.js';

const [userId, manifestFile = 'sandbox-test-data/manifest.json', ...extra] = process.argv.slice(2);
if (!userId || extra.length || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(userId)) {
  console.error('Usage: npm run import:paypal-seed -- <user-uuid> [manifest.json]');
  process.exit(2);
}
try {
  const { rows } = await query('SELECT id FROM users WHERE id=$1', [userId]);
  if (!rows.length) throw new Error('User not found');
  const creds = await getPaypalCreds(userId);
  if (creds.baseUrl !== 'https://api-m.sandbox.paypal.com' || creds.clientId !== config.paypal.clientId || creds.clientSecret !== config.paypal.clientSecret) throw new Error('Selected user must use the sandbox credentials in .env');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (!Array.isArray(manifest.transactions)) throw new Error('Missing capture records in manifest');
  // Verify ownership, amount and status against the merchant API before caching.
  const auth = await fetch(`${creds.baseUrl}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(config.paypal.timeoutMs) });
  if (!auth.ok) throw new Error(`PayPal OAuth failed (${auth.status})`);
  const { access_token: token } = await auth.json() as { access_token: string };
  for (const txn of manifest.transactions as PaypalTransactionNormalized[]) {
    const res = await fetch(`${creds.baseUrl}/v2/payments/captures/${encodeURIComponent(txn.transactionId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(config.paypal.timeoutMs) });
    if (!res.ok) throw new Error(`Cannot verify capture ${txn.transactionId} (${res.status})`);
    const cap = await res.json() as { status: string; amount: { value: string; currency_code: string } };
    if (cap.status !== txn.status || Number(cap.amount.value) !== txn.amount || cap.amount.currency_code !== txn.currency) throw new Error(`Capture ${txn.transactionId} changed; refresh the manifest before importing`);
  }
  await ensurePaypalCacheAccount(userId);
  const stored = await upsertPaypalTransactions(userId, manifest.transactions);
  console.log(`Imported ${stored} verified PayPal capture records for ${userId}. Upload the generated images to your selected Drive folder, then run Scan.`);
} catch (error) {
  console.error(error instanceof Error ? error.message || 'Database connection failed' : String(error));
  process.exitCode = 1;
} finally { await pool.end(); }
