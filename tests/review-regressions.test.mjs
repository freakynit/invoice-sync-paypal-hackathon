import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { pool } from '../dist/db/pool.js';
import { config } from '../dist/config.js';
import { fetchRazorpayPayments, upsertRazorpayPayments } from '../dist/services/razorpay.js';
import { upsertPaypalTransactions } from '../dist/services/paypal.js';
import { captureSeedOrder } from '../dist/services/paypalSeed.js';
import { candidateLookup, scoreMatch } from '../dist/services/matching.js';
import express from 'express';
import authRouter from '../dist/routes/auth.js';
import paypalRouter from '../dist/routes/paypal.js';
import { signSession } from '../dist/utils/auth.js';
import { isStrongPassword } from '../dist/utils/auth.js';

after(() => pool.end());

test('Razorpay aborts full-page pagination instead of returning partial coverage', async () => {
  const oldQuery = pool.query, oldFetch = globalThis.fetch, saved = { ...config.razorpay };
  let calls = 0;
  try {
    Object.assign(config.razorpay, { enabled: true, maxPages: 3, pageSize: 1 });
    pool.query = async () => ({ rows: [{ key_id: 'key', key_secret: 'secret' }] });
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ items: [{ id: 'repeated' }] })); };
    await assert.rejects(fetchRazorpayPayments('user', new Date(), new Date()), /pagination limit/);
    assert.equal(calls, 3);
  } finally { pool.query = oldQuery; globalThis.fetch = oldFetch; Object.assign(config.razorpay, saved); }
});

test('seed capture rejects every state requiring buyer action before posting a capture', async () => {
  const oldQuery = pool.query, oldFetch = globalThis.fetch;
  try {
    pool.query = async () => ({ rows: [{ client_id: 'key', client_secret: 'secret' }] });
    for (const status of ['PAYER_ACTION_REQUIRED', 'CREATED', 'COMPLETED']) {
      let captures = 0;
      globalThis.fetch = async (url, init) => {
        if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'token' }));
        if (init.method === 'POST') captures++;
        return new Response(JSON.stringify({ id: 'order', status }));
      };
      await assert.rejects(captureSeedOrder('user', 'order'), /Approve this order/);
      assert.equal(captures, 0);
    }
  } finally { pool.query = oldQuery; globalThis.fetch = oldFetch; }
});

test('payment batches limit query size and keep the last repeated observation', async () => {
  for (const [upsert, idField] of [[upsertPaypalTransactions, 'transactionId'], [upsertRazorpayPayments, 'paymentId']]) {
    const items = Array.from({ length: 1001 }, (_, i) => ({ [idField]: 'payment-' + i, amount: 10,
      initiatedAt: '2026-09-01T00:00:00Z', raw: { i } }));
    items.push({ ...items[0], amount: 20 });
    const calls = [];
    assert.equal(await upsert('user', items, async (sql, params) => calls.push({ sql, params })), 1002);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(c => c.params.length), [6500, 6500, 13]);
    assert.equal(calls[0].params[5 + (idField === 'paymentId' ? 1 : 0)], 20);
    assert.equal(await upsert('user', [], async () => assert.fail('Empty input queried DB')), 0);
  }
});

test('matching prefilter preserves the strongest candidates and ambiguity runners-up', () => {
  const txns = Array.from({ length: 200 }, (_, i) => ({ id: String(i).padStart(3, '0'), provider: 'paypal',
    status: 'S', event_code: 'T0006', amount: String(i + 1000), currency: 'USD', payer_email: null,
    transaction_initiated_at: '2020-01-01T00:00:00Z', raw_json: {} }));
  txns.push({ ...txns[0], id: 'identity', raw_json: { nested: { invoice_id: 'INV-42' } } });
  txns.push({ ...txns[0], id: 'custom', raw_json: { custom_id: 'invoice-sync:INV-42' } });
  txns.push({ ...txns[0], id: 'description', raw_json: { description: 'Paid INV-42 today' } });
  txns.push({ ...txns[0], id: 'amount', amount: '10.5' });
  txns.push({ ...txns[0], id: 'date', transaction_initiated_at: '2026-09-02T00:00:00Z' });
  const invoice = { id: 'invoice', invoice_number: 'INV-42', amount: '10', currency: 'EUR',
    invoice_date: '2026-09-01', payer_email: 'payer@example.com' };
  const lookup = candidateLookup(txns);
  for (const inv of [invoice, { ...invoice, currency: 'USD' }, { ...invoice, invoice_number: '42' },
    { ...invoice, invoice_number: null, amount: null, currency: null, invoice_date: null }]) {
    const rank = items => items.map(txn => ({ ...txn, ...scoreMatch(inv,txn) })).filter(t => t.eligible)
      .sort((a,b) => b.identifierRank-a.identifierRank || b.score-a.score || a.id.localeCompare(b.id))
      .slice(0,2).map(t => t.id);
    assert.deepEqual(rank(lookup(inv)), rank(txns));
  }
  assert.ok(lookup(invoice).length < 10);
  assert.ok(lookup({ ...invoice, invoice_number: null, amount: null, currency: 'USD', invoice_date: null }).length <= 2);
});

test('new passwords require 12 characters and fit bcrypt UTF-8 input limits', () => {
  assert.equal(isStrongPassword('12345678'), false);
  assert.equal(isStrongPassword('a long passphrase'), true);
  assert.equal(isStrongPassword('x'.repeat(72)), true);
  assert.equal(isStrongPassword('x'.repeat(73)), false);
  assert.equal(isStrongPassword('😀'.repeat(19)), false);
});

test('OAuth callbacks and seed routes return safe errors without internal provider details', async () => {
  const oldQuery = pool.query, oldGoogle = { ...config.auth.google };
  const app = express(); app.use(express.json()); app.use('/auth', authRouter); app.use('/paypal', paypalRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer ' + signSession({ userId: 'user', email: 'review@example.com' }), 'Content-Type': 'application/json' };
  try {
    config.auth.google.clientId = 'configured'; config.auth.google.clientSecret = 'configured';
    pool.query = async () => { throw new Error('internal-provider-detail-sentinel'); };
    for (const url of ['/auth/paypal/callback?code=code&state=state', '/auth/google/callback?code=code&state=state']) {
      const response = await fetch(base+url, { headers });
      assert.equal(response.status, 500);
      assert.equal((await response.text()).includes('internal-provider-detail-sentinel'), false);
    }
    const response = await fetch(base+'/paypal/seed/capture', { method: 'POST', headers, body: JSON.stringify({ orderId: 'order' }) });
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes('internal-provider-detail-sentinel'), false);
  } finally {
    pool.query = oldQuery; Object.assign(config.auth.google, oldGoogle);
    await new Promise(resolve => server.close(resolve));
  }
});
