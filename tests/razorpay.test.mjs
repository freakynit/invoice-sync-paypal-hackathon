import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { config } from '../dist/config.js';
import { pool } from '../dist/db/pool.js';
import { fetchRazorpayPayments, fromMinorUnits, syncRazorpayPayments } from '../dist/services/razorpay.js';
import { scoreMatch } from '../dist/services/matching.js';
import router from '../dist/routes/razorpay.js';
import { signSession } from '../dist/utils/auth.js';

test('Razorpay currency conversion, date filters, pagination, real connection tests and disable switch', async () => {
  const savedQuery = pool.query, savedFetch = globalThis.fetch;
  const savedConfig = { ...config.razorpay };
  pool.query = async () => ({ rows: [{ key_id: 'rzp_test_key', key_secret: 'secret' }] });
  const start = new Date('2026-09-01T00:00:00Z'), end = new Date('2026-09-02T00:00:00Z');
  try {
    for (const [code, minor, major] of [['INR', 12345, 123.45], ['JPY', 123, 123], ['KWD', 123450, 123.45], ['BHD', 4560, 4.56], ['OMR', 990, .99]]) {
      assert.equal(fromMinorUnits(minor, code), major);
    }
    config.razorpay.enabled = true; config.razorpay.pageSize = 2;
    const skips = [];
    globalThis.fetch = async url => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('from'), String(start.getTime() / 1000));
      assert.equal(params.get('to'), String(end.getTime() / 1000));
      skips.push(Number(params.get('skip')));
      return new Response(JSON.stringify({ items: skips.length === 1 ? [
        { id: 'pay_one', amount: 123450, currency: 'KWD', created_at: start.getTime() / 1000 },
        { id: 'pay_two', amount: 100, currency: 'INR', created_at: start.getTime() / 1000 },
      ] : [] }));
    };
    const payments = await fetchRazorpayPayments('user', start, end);
    assert.deepEqual(skips, [0, 2]); assert.equal(payments[0].amount, 123.45);
    globalThis.fetch = async () => new Response(JSON.stringify({ unexpected: [] }));
    await assert.rejects(fetchRazorpayPayments('user', start, end), /items missing/);
    config.razorpay.pageSize = 100;
    globalThis.fetch = async url => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      return new Response(JSON.stringify({ items: skip <= 10000 ? Array.from({ length: 100 }, (_, i) => ({ id: `pay_${skip+i}`, created_at: start.getTime() / 1000 })) : [] }));
    };
    assert.equal((await fetchRazorpayPayments('user', start, end)).length, 10100);
    const invoice = { id: 'invoice', invoice_number: 'INV-42', amount: '10', currency: 'INR', invoice_date: null, payer_email: null };
    const score = scoreMatch(invoice, { provider: 'razorpay', status: 'captured', amount: '10', currency: 'INR', raw_json: { invoice_id: 'inv_provider_id', notes: { invoice_number: 'INV-42' } } });
    assert.equal(score.identifierRank, 3); assert.equal(score.conflicts.includes('Payment invoice number differs'), false);
    const app = express(); app.use(express.json()); app.use('/razorpay', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/razorpay`;
    const headers = { Authorization: 'Bearer ' + signSession({ userId: 'user', email: 'test@example.com' }), 'Content-Type': 'application/json' };
    try {
      globalThis.fetch = async () => new Response('{}', { status: 401 });
      // /test must contact Razorpay, even when local payment data already exists.
      assert.equal((await savedFetch(base + '/test', { headers })).status, 500);
      const invalid = await savedFetch(base + '/credentials', { method: 'PUT', headers, body: JSON.stringify({ keyId: '     ', keySecret: '     ' }) });
      assert.equal(invalid.status, 400);
      config.razorpay.enabled = false;
      pool.query = async () => { throw new Error('Disabled integration must not query DB'); };
      for (const path of ['/status', '/payments', '/test']) assert.equal((await savedFetch(base + path, { headers })).status, 404);
      assert.equal(await syncRazorpayPayments('user', start, end), 0);
      await assert.rejects(fetchRazorpayPayments('user', start, end), /disabled/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally {
    pool.query = savedQuery; globalThis.fetch = savedFetch; Object.assign(config.razorpay, savedConfig); await pool.end();
  }
});
