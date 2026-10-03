import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import express from 'express';
import { pool } from '../dist/db/pool.js';
import { config } from '../dist/config.js';
import * as migrations from '../dist/db/migrations.js';
import { getOrCreateSyncConfig, setCadence } from '../dist/services/scheduler.js';
import { buildPaypalLoginUrl, consumePaypalState } from '../dist/services/paypalAuth.js';
import { upsertPaypalTransactions, syncPaypalTransactions } from '../dist/services/paypal.js';
import { upsertRazorpayPayments } from '../dist/services/razorpay.js';
import { recomputeMatches } from '../dist/services/matching.js';
import { authRateLimit } from '../dist/middleware/authRateLimit.js';
import { startEmailWorker, stopEmailWorker } from '../dist/services/emailWorker.js';

// Opt in: creates and drops an isolated schema in the configured database.
test('PostgreSQL concurrency, OAuth, payment upserts, throttling, matching and email recovery',
  { skip: process.env.TEST_DATABASE !== '1', timeout: 30000 }, async t => {
  const schema = 'review_' + randomUUID().replaceAll('-', '');
  const adminQuery = pool.query.bind(pool), originalQuery = pool.query, originalConnect = pool.connect;
  const savedConfig = structuredClone(config), originalFetch = globalThis.fetch;
  const db = new Pool({ ...pool.options, options: `-c search_path=${schema},public` });
  let server;
  await adminQuery(`CREATE SCHEMA ${schema}`);
  try {
    // gen_random_uuid is built into PostgreSQL; do not install global extensions in this test.
    for (const [name, sql] of Object.entries(migrations).sort()) {
      if (name.startsWith('MIGRATION_')) await db.query(sql.replace('CREATE EXTENSION IF NOT EXISTS "pgcrypto";', ''));
    }
    await db.query(migrations.MIGRATION_008); // Idempotence.
    pool.query = db.query.bind(db); pool.connect = db.connect.bind(db);
    const user = (await db.query("INSERT INTO users (email) VALUES ('review@example.com') RETURNING id")).rows[0].id;
    const other = (await db.query("INSERT INTO users (email) VALUES ('other@example.com') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO paypal_connections(user_id,client_id,client_secret) VALUES ($1,'review-client','secret'),($2,'review-client','secret')", [user, other]);
    config.razorpay.enabled = true;
    config.razorpay.keyId = 'review-key'; config.razorpay.keySecret = 'secret';

    await t.test('concurrent sync config creation preserves existing cadence', async () => {
      const configs = await Promise.all(Array.from({ length: 12 }, () => getOrCreateSyncConfig(user)));
      assert.ok(configs.every(c => c.cadence === 'none'));
      await setCadence(user, '1h');
      assert.equal((await getOrCreateSyncConfig(user)).cadence, '1h');
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM sync_configs WHERE user_id=$1', [user])).rows[0].n, 1);
    });

    await t.test('OAuth state works across module instances, rejects wrong users, expiry and replay', async () => {
      const state = new URL(await buildPaypalLoginUrl(user)).searchParams.get('state');
      assert.equal(await consumePaypalState(state, other), undefined);
      const freshModule = await import('../dist/services/paypalAuth.js?new-instance');
      const results = await Promise.all([freshModule.consumePaypalState(state, user), consumePaypalState(state, user)]);
      assert.equal(results.filter(v => v === user).length, 1);
      assert.equal(results.filter(v => v === undefined).length, 1);
      await db.query("INSERT INTO paypal_oauth_states VALUES ('expired',$1,NOW()-INTERVAL '1 minute')", [user]);
      assert.equal(await consumePaypalState('expired', user), undefined);
    });

    const paypal = { transactionId: 'review-payment', referenceId: null, eventCode: 'T0006', status: 'S', amount: 10,
      currency: 'USD', fee: null, payerEmail: 'buyer@example.com', payerName: null,
      initiatedAt: '2026-09-01T00:00:00Z', updatedAt: null, raw: { invoice_id: 'INV-42' } };
    await t.test('batched upserts execute on PostgreSQL, preserve last duplicates and null dates', async () => {
      await upsertPaypalTransactions(user, [paypal, { ...paypal, amount: 20 }]);
      assert.equal(Number((await db.query('SELECT amount FROM paypal_transactions')).rows[0].amount), 20);
      await upsertPaypalTransactions(user, [paypal]);
      const razor = { paymentId: 'pay-review', orderId: null, invoiceId: null, method: 'card', status: 'captured',
        amount: 1, currency: 'INR', payerEmail: null, payerContact: null, description: null, initiatedAt: null, raw: {} };
      await upsertRazorpayPayments(user, [razor, razor]);
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM razorpay_payments')).rows[0].n, 2);
      await upsertRazorpayPayments(user, [{ ...razor, initiatedAt: paypal.initiatedAt }, { ...razor, initiatedAt: paypal.initiatedAt, amount: 2 }]);
      assert.equal(Number((await db.query('SELECT amount FROM razorpay_payments WHERE transaction_initiated_at IS NOT NULL')).rows[0].amount), 2);
    });

    await t.test('recompute uses SQL prefilter and still retains identifiers outside date/amount windows', async () => {
      await db.query(`INSERT INTO invoices(user_id,drive_file_id,drive_file_name,status,invoice_number,amount,currency,invoice_date,payer_email)
        VALUES ($1,'review-file','review.pdf','extracted','INV-42',10,'USD','2026-09-01','buyer@example.com')`, [user]);
      const stats = await recomputeMatches(user, null);
      assert.equal(stats.matched, 1);
      await db.query("UPDATE invoices SET amount=999,currency='EUR',invoice_date='2020-01-01',payer_email=NULL WHERE user_id=$1", [user]);
      const outside = await recomputeMatches(user, null);
      assert.equal(outside.review, 1);
    });

    await t.test('OAuth token requests coalesce across users and cache credential sets independently', async () => {
      let tokens = 0;
      globalThis.fetch = async url => {
        if (url.endsWith('/token')) { tokens++; return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 })); }
        return new Response(JSON.stringify({ transaction_details: [], total_pages: 1 }));
      };
      const start = new Date('2026-08-01T00:00:00Z'), end = new Date('2026-08-01T23:59:59Z');
      await Promise.all([syncPaypalTransactions(user, start, end), syncPaypalTransactions(other, start, end)]);
      assert.equal(tokens, 1);
      await db.query("UPDATE paypal_connections SET client_secret='rotated' WHERE user_id=$1", [other]);
      const second = new Date('2026-08-02T00:00:00Z');
      await syncPaypalTransactions(other, second, new Date('2026-08-02T23:59:59Z'));
      assert.equal(tokens, 2);
      await syncPaypalTransactions(user, second, new Date('2026-08-02T23:59:59Z'));
      assert.equal(tokens, 2);
      globalThis.fetch = originalFetch;
    });

    await t.test('shared IP/account throttles enforce concurrent attempts and expire', async () => {
      config.auth.rateLimit.loginMax = 2;
      config.auth.rateLimit.emailMax = 2;
      const app = express(); app.set('trust proxy', 1); app.use(express.json());
      app.use('/auth', authRateLimit); app.post('/auth/:action', (_req,res) => res.json({ ok: true }));
      app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
      server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}/auth`;
      const attempt = (action, email, ip) => originalFetch(base+'/'+action, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email }) });
      const responses = await Promise.all(Array.from({ length: 8 }, (_,i) => attempt('login', 'account'+i+'@example.com', '198.51.100.1')));
      assert.equal(responses.filter(r => r.status === 200).length, 2);
      assert.equal(responses.filter(r => r.status === 429).length, 6);
      assert.ok(Number(responses.find(r => r.status === 429).headers.get('Retry-After')) > 0);
      assert.equal((await attempt('forgot-password','target@example.com','198.51.100.2')).status, 200);
      assert.equal((await attempt('signup','target@example.com','198.51.100.3')).status, 200);
      assert.equal((await attempt('resend-verification','target@example.com','198.51.100.4')).status, 429);
      await db.query("UPDATE auth_rate_limits SET expires_at=NOW()-INTERVAL '1 second'");
      assert.equal((await attempt('login','account@example.com','198.51.100.1')).status, 200);
    });

    await t.test('expired email claims recover, exhausted attempts fail, shutdown drains the batch', async () => {
      config.app.simulateEmailSending = true; config.mail.pollIntervalMs = 1;
      config.mail.concurrency = 1; config.mail.batchSize = 10;
      await db.query(`INSERT INTO email_jobs (to_address,subject,body_html,status,attempts,max_attempts,updated_at)
        VALUES ('review@example.com','recover','body','processing',0,3,NOW()-INTERVAL '1 hour'),
               ('review@example.com','exhausted','body','processing',2,3,NOW()-INTERVAL '1 hour'),
               ('review@example.com','pending','body','pending',0,3,NOW())`);
      let announce, release;
      const entered = new Promise(resolve => announce=resolve), gate = new Promise(resolve => release=resolve);
      let blocked = false;
      pool.query = async (...args) => {
        if (!blocked && args[0].includes("SET status='success'")) { blocked=true; announce(); await gate; }
        return db.query(...args);
      };
      startEmailWorker();
      await entered;
      let stopped = false;
      const shutdown = stopEmailWorker().then(() => stopped=true);
      await Promise.resolve(); assert.equal(stopped, false);
      release(); await shutdown;
      pool.query = db.query.bind(db);
      const rows = (await db.query('SELECT subject,status,attempts,claim_token FROM email_jobs ORDER BY subject')).rows;
      assert.deepEqual(rows.map(r => [r.subject,r.status,r.attempts]), [['exhausted','failed',3],['pending','success',0],['recover','success',1]]);
      assert.ok(rows.every(r => r.claim_token === null));
    });
  } finally {
    await stopEmailWorker();
    if (server) await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch; Object.assign(config, savedConfig);
    pool.query = originalQuery; pool.connect = originalConnect;
    await db.end();
    await adminQuery(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
