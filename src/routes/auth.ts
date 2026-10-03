import { Router, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { google } from 'googleapis';
import { config, isChatConfigured, isClerkConfigured, isDemoEnabled, isGoogleConfigured, isPaypalConfigured } from '../config.js';
import { query } from '../db/pool.js';
import { hashPassword, isStrongPassword, isValidEmail, randomToken, signSession, verifyPassword } from '../utils/auth.js';
import { createEmailVerificationToken, createPasswordResetToken, hashToken, sendPasswordResetEmail, sendVerificationEmail } from '../services/email.js';
import { googleOAuthClient } from '../services/drive.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

import { authRateLimit } from '../middleware/authRateLimit.js';
import { logError } from '../utils/logger.js';

const router = Router();
router.post(['/login', '/signup', '/forgot-password', '/resend-verification', '/demo'], authRateLimit);

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.server.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.app.env === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}

const signupSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email(),
  password: z.string().max(128).refine(isStrongPassword, 'Use at least 12 characters, up to 72 UTF-8 bytes'),
});

router.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const { name, email, password } = parsed.data;
  if (!isValidEmail(email) || !isStrongPassword(password)) {
    res.status(400).json({ error: 'Invalid email or password (use at least 12 characters, up to 72 UTF-8 bytes).' });
    return;
  }
  const normalized = email.trim().toLowerCase();
  const existing = await query<{ id: string }>(`SELECT id FROM users WHERE LOWER(email)=$1`, [normalized]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
    return;
  }
  const passwordHash = await hashPassword(password);
  const created = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, updated_at) VALUES ($1,$2,$3,NOW()) RETURNING id`,
    [normalized, passwordHash, name?.trim() || null],
  );
  const userId = created.rows[0].id;
  const rawToken = await createEmailVerificationToken(userId);
  const link = `${config.app.publicBaseUrl}/verify-email?token=${rawToken}`;
  await sendVerificationEmail(normalized, link);
  res.status(201).json({ message: 'Account created. Please check your email to verify.', userId });
});

const loginSchema = z.object({ email: z.string().trim(), password: z.string() });

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }
  const normalized = parsed.data.email.trim().toLowerCase();
  const { rows } = await query<{ id: string; email: string; password_hash: string | null; email_verified_at: string | null; name: string | null }>(
    `SELECT id, email, password_hash, email_verified_at, name FROM users WHERE LOWER(email)=$1`,
    [normalized],
  );
  const user = rows[0];
  if (!user || !user.password_hash || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }
  if (!user.email_verified_at) {
    res.status(403).json({ error: 'Email not verified. Please check your inbox for the verification link.', code: 'EMAIL_NOT_VERIFIED' });
    return;
  }
  const token = signSession({ userId: user.id, email: user.email });
  setSessionCookie(res, token);
  res.json({ message: 'Logged in', token, user: { id: user.id, email: user.email, name: user.name } });
});

router.post('/logout', (_req, res) => {
  res.clearCookie(config.server.sessionCookieName, { path: '/' });
  res.json({ message: 'Logged out' });
});

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const { rows } = await query<{ id: string; email: string; name: string | null; email_verified_at: string | null; avatar_url: string | null }>(
    `SELECT id, email, name, email_verified_at, avatar_url FROM users WHERE id=$1`,
    [req.userId],
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { isDemoEmail } = await import('../services/demo.js');
  res.json({ user: rows[0], googleConfigured: isGoogleConfigured(), clerkEnabled: isClerkConfigured(), paypalLoginEnabled: isPaypalConfigured(), isDemo: isDemoEmail(rows[0].email), demoEnabled: isDemoEnabled(), chatEnabled: isChatConfigured(), chatModel: config.chat.model });
});

router.post('/verify-email', async (req, res) => {
  const token = String(req.body?.token ?? req.query?.token ?? '');
  if (!token) {
    res.status(400).json({ error: 'Verification token is required.' });
    return;
  }
  const { rows } = await query<{ id: string; user_id: string; expires_at: string; consumed_at: string | null }>(
    `SELECT id, user_id, expires_at, consumed_at FROM email_verification_tokens WHERE token_hash=$1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'Verification link is invalid or expired.' });
    return;
  }
  await query(`UPDATE email_verification_tokens SET consumed_at=NOW() WHERE id=$1`, [row.id]);
  await query(`UPDATE users SET email_verified_at=NOW(), updated_at=NOW() WHERE id=$1`, [row.user_id]);
  res.json({ message: 'Email verified. You can now log in.' });
});

router.post('/resend-verification', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Valid email is required.' });
    return;
  }
  const { rows } = await query<{ id: string; email_verified_at: string | null }>(`SELECT id, email_verified_at FROM users WHERE LOWER(email)=$1`, [email]);
  if (!rows[0]) {
    res.json({ message: 'If an account exists, a verification email was sent.' });
    return;
  }
  if (rows[0].email_verified_at) {
    res.json({ message: 'Email is already verified. You can log in.' });
    return;
  }
  const raw = await createEmailVerificationToken(rows[0].id);
  await sendVerificationEmail(email, `${config.app.publicBaseUrl}/verify-email?token=${raw}`);
  res.json({ message: 'Verification email sent.' });
});

router.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Valid email is required.' });
    return;
  }
  const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE LOWER(email)=$1`, [email]);
  if (rows[0]) {
    const raw = await createPasswordResetToken(rows[0].id);
    await sendPasswordResetEmail(email, `${config.app.publicBaseUrl}/reset-password?token=${raw}`);
  }
  res.json({ message: 'If an account exists, a reset link was sent.' });
});

router.post('/reset-password', async (req, res) => {
  const schema = z.object({ token: z.string().min(10), password: z.string().max(128).refine(isStrongPassword, 'Use at least 12 characters, up to 72 UTF-8 bytes') });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Token and a new password (at least 12 characters, up to 72 UTF-8 bytes) are required.' });
    return;
  }
  const { rows } = await query<{ id: string; user_id: string; expires_at: string; consumed_at: string | null }>(
    `SELECT id, user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash=$1`,
    [hashToken(parsed.data.token)],
  );
  const row = rows[0];
  if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'Reset link is invalid or expired.' });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  await query(`UPDATE password_reset_tokens SET consumed_at=NOW() WHERE id=$1`, [row.id]);
  await query(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [passwordHash, row.user_id]);
  res.json({ message: 'Password updated. You can now log in.' });
});

// --- Public frontend config (publishable key is public by design) ---
router.get('/config', (_req, res) => {
  res.json({
    appName: config.app.name,
    clerkEnabled: isClerkConfigured(),
    clerkPublishableKey: isClerkConfigured() ? config.clerk.publishableKey : null,
    googleConfigured: isGoogleConfigured(),
    paypalLoginEnabled: isPaypalConfigured(),
    razorpayEnabled: config.razorpay.enabled,
    demoEnabled: isDemoEnabled(),
    demoEmail: config.demo.email,
    chatEnabled: true,
    chatModel: config.chat.model,
    chatConfigured: isChatConfigured(),
  });
});

// --- One-click demo mode for judges (no PayPal/Drive/Clerk keys needed) ---
// Creates (or reuses) a seeded demo workspace and logs the judge in immediately.
router.post('/demo', async (_req, res) => {
  try {
    if (!isDemoEnabled()) {
      res.status(403).json({ error: 'Demo mode is disabled on this server.' });
      return;
    }
    const { ensureDemoUser, seedDemoData } = await import('../services/demo.js');
    const user = await ensureDemoUser();
    await seedDemoData(user.id);
    const { rows } = await query<{ id: string; email: string; name: string | null }>(`SELECT id, email, name FROM users WHERE id=$1`, [user.id]);
    const session = signSession({ userId: rows[0].id, email: rows[0].email });
    setSessionCookie(res, session);
    res.json({ message: 'Demo workspace ready — no keys needed.', user: rows[0], isDemo: true });
  } catch (err) {
    logError('Demo login failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Could not start demo mode. Is Postgres running and migrated?' });
  }
});

router.post('/demo/reset', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { isDemoUser, resetDemoData } = await import('../services/demo.js');
    if (!(await isDemoUser(req.userId!))) {
      res.status(403).json({ error: 'Only the demo workspace can be reset.' });
      return;
    }
    const counts = await resetDemoData(req.userId!);
    res.json({ message: 'Demo workspace reset to the seeded dataset.', ...counts });
  } catch (err) {
    logError('Demo reset failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Could not reset demo data.' });
  }
});

// --- Clerk sign-in exchange ---
// Frontend signs in with ClerkJS, then POSTs the Clerk session token here.
// We verify it server-side, link/create the local user, and set our own
// session cookie so the rest of the app works unchanged.
router.post('/clerk', async (req, res) => {
  try {
    if (!isClerkConfigured()) {
      res.status(501).json({ error: 'Clerk is not configured.' });
      return;
    }
    const token = String(req.body?.token ?? '');
    if (!token) {
      res.status(400).json({ error: 'Clerk session token is required.' });
      return;
    }
    const { verifyClerkSessionToken, findOrCreateUserFromClerk } = await import('../services/clerk.js');
    const profile = await verifyClerkSessionToken(token);
    const user = await findOrCreateUserFromClerk(profile);
    const session = signSession({ userId: user.id, email: user.email });
    setSessionCookie(res, session);
    res.json({ message: 'Logged in with Clerk', user });
  } catch (err) {
    logError('Clerk verification failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(401).json({ error: 'Clerk verification failed.' });
  }
});

// --- Connect with PayPal (existing workspace account only) ---
// Two connection options exist for end users:
//  A) PayPal login redirect (this flow) — links the PayPal identity. Needs the
//     exact Return URL (config.paypal.returnUrl) registered in that PayPal app.
//  B) Client ID + Secret saved in Dashboard → PayPal — data-only, needs no
//     Return URL. When a logged-in user saved their own credentials, this flow
//     uses THEIR app (their Return URL registration) instead of the server's.
router.get('/paypal/url', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { buildPaypalLoginUrl } = await import('../services/paypalAuth.js');
    const url = await buildPaypalLoginUrl(req.userId!);
    if ((req.headers.accept ?? '').includes('application/json')) { res.json({ url }); return; }
    res.redirect(url);
  } catch (err) {
    logError('PayPal login URL failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(501).json({ error: 'Could not start PayPal connection. Check the configured credentials.' });
  }
});

router.get('/paypal/callback', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    if (!code) {
      res.status(400).send('Missing authorization code from PayPal.');
      return;
    }
    const { consumePaypalState, exchangePaypalCode, fetchPaypalProfile, loginCredsFor } = await import(
      '../services/paypalAuth.js'
    );
    const boundUserId = await consumePaypalState(state, req.userId!);
    if (!boundUserId || boundUserId !== req.userId) {
      res.status(400).send('Invalid or expired login state. Please try again.');
      return;
    }
    const creds = await loginCredsFor(boundUserId);
    const accessToken = await exchangePaypalCode(code, creds);
    const profile = await fetchPaypalProfile(accessToken, creds.baseUrl);
    await query(`UPDATE users SET paypal_payer_id=$1, updated_at=NOW() WHERE id=$2`, [profile.payerId, boundUserId]);
    res.redirect('/dashboard#paypal');
  } catch (err) {
    logError('PayPal connection failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).send('PayPal connection failed. Please reconnect from the dashboard.');
  }
});

// Google sign-in uses Clerk; this callback only connects Drive to an existing user.
router.get('/google/url', (_req, res) => {
  res.status(410).json({ error: 'Use Continue with Google on the login or signup page.' });
});

router.get('/google/callback', requireAuth, async (req: AuthedRequest, res) => {
  try {
    if (!isGoogleConfigured()) { res.status(501).send('Google OAuth is not configured.'); return; }
    const state = String(req.query.state ?? '');
    const { rows } = await query<{ user_id: string }>(
      `DELETE FROM drive_oauth_states WHERE state=$1 AND user_id=$2 AND expires_at > NOW() RETURNING user_id`,
      [state, req.userId],
    );
    if (!rows[0]) { res.status(400).send('Invalid or expired Drive connection. Please reconnect from the dashboard.'); return; }
    if (req.query.error) { res.redirect('/dashboard#drive'); return; }
    const code = String(req.query.code ?? '');
    if (!code) { res.status(400).send('Missing OAuth code.'); return; }
    const client = googleOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    const email = String(me.data.email ?? '').toLowerCase();
    if (!email) { res.status(400).send('Could not read Google email.'); return; }
    await query(
      `INSERT INTO google_drive_connections (user_id, google_email, access_token, refresh_token, access_token_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id) DO UPDATE SET google_email=EXCLUDED.google_email,
         access_token=EXCLUDED.access_token,
         refresh_token=CASE WHEN google_drive_connections.google_email=EXCLUDED.google_email
           THEN COALESCE(EXCLUDED.refresh_token,google_drive_connections.refresh_token) ELSE EXCLUDED.refresh_token END,
         folders=CASE WHEN google_drive_connections.google_email=EXCLUDED.google_email THEN google_drive_connections.folders ELSE '[]'::jsonb END,
         folder_id=CASE WHEN google_drive_connections.google_email=EXCLUDED.google_email THEN google_drive_connections.folder_id ELSE NULL END,
         folder_name=CASE WHEN google_drive_connections.google_email=EXCLUDED.google_email THEN google_drive_connections.folder_name ELSE NULL END,
         access_token_expires_at=EXCLUDED.access_token_expires_at, updated_at=NOW()`,
      [req.userId, email, tokens.access_token ?? null, tokens.refresh_token ?? null,
        tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null],
    );
    res.redirect('/dashboard#drive');
  } catch (err) {
    logError('Google Drive connection failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).send('Google Drive connection failed. Please reconnect from the dashboard.');
  }
});

export default router;
