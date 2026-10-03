import { config, isPaypalConfigured } from '../config.js';
import { query } from '../db/pool.js';
import { randomToken } from '../utils/auth.js';

export const PAYPAL_LOGIN_SCOPES = 'openid profile email';

export interface PaypalProfile {
  payerId: string;
  email: string;
  name: string | null;
  verified: boolean;
}

export interface PaypalLoginCreds {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  connectHost: string;
}

/**
 * Credentials for the Login with PayPal flow. Prefers the user's own
 * Client ID/Secret when they saved one (their own PayPal app), otherwise
 * falls back to the server's app. The Client ID/Secret data path never
 * needs a Return URL; only the PayPal-login redirect does.
 */
export async function loginCredsFor(userId: string | null): Promise<PaypalLoginCreds> {
  if (userId) {
    const { rows } = await query<{ client_id: string | null; client_secret: string | null; base_url: string | null; mode: string }>(
      `SELECT client_id, client_secret, base_url, mode FROM paypal_connections WHERE user_id=$1`,
      [userId],
    );
    const row = rows[0];
    if (row?.client_id && row?.client_secret) {
      const mode = row.mode === 'live' ? 'live' : 'sandbox';
      return {
        clientId: row.client_id,
        clientSecret: row.client_secret,
        baseUrl: (row.base_url || (mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/$/, ''),
        connectHost: mode === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com',
      };
    }
  }
  if (!isPaypalConfigured()) throw new Error('PayPal is not configured. Save your Client ID and Secret first.');
  return {
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    baseUrl: config.paypal.baseUrl,
    connectHost: config.paypal.mode === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com',
  };
}

export async function buildPaypalLoginUrl(userId: string | null): Promise<string> {
  const creds = await loginCredsFor(userId);
  const state = randomToken(16);
  await query('DELETE FROM paypal_oauth_states WHERE expires_at <= NOW()');
  await query("INSERT INTO paypal_oauth_states (state,user_id,expires_at) VALUES ($1,$2,NOW() + INTERVAL '10 minutes')", [state,userId]);
  const params = new URLSearchParams({
    flowEntry: 'static',
    client_id: creds.clientId,
    response_type: 'code',
    scope: PAYPAL_LOGIN_SCOPES,
    redirect_uri: config.paypal.returnUrl,
    state,
  });
  return `${creds.connectHost}/connect?${params.toString()}`;
}

/** Returns the bound userId, null for an unbound flow, or undefined if invalid. */
export async function consumePaypalState(state: string, userId: string | null): Promise<string | null | undefined> {
  const { rows } = await query<{ user_id: string | null }>(
    `DELETE FROM paypal_oauth_states WHERE state=$1 AND user_id IS NOT DISTINCT FROM $2::uuid
     AND expires_at > NOW() RETURNING user_id`, [state, userId]);
  return rows.length ? rows[0].user_id : undefined;
}

export async function exchangePaypalCode(code: string, creds: PaypalLoginCreds): Promise<string> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const res = await fetch(`${creds.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
    signal: AbortSignal.timeout(config.paypal.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`PayPal code exchange failed (${res.status}). The Return URL ${config.paypal.returnUrl} must be registered in that PayPal app.`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('PayPal did not return an access token.');
  return data.access_token;
}

export async function fetchPaypalProfile(accessToken: string, baseUrl: string): Promise<PaypalProfile> {
  const res = await fetch(`${baseUrl}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(config.paypal.timeoutMs),
  });
  if (!res.ok) throw new Error(`PayPal userinfo failed (${res.status}).`);
  const data = (await res.json()) as {
    user_id?: string;
    email?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    verified_account?: boolean;
  };
  if (!data.email) throw new Error('PayPal account has no email address.');
  const fullName = [data.given_name, data.family_name].filter(Boolean).join(' ');
  const name = data.name ?? (fullName === '' ? null : fullName);
  return {
    payerId: String(data.user_id ?? data.email).split('/').pop() as string,
    email: data.email.toLowerCase(),
    name,
    verified: data.verified_account !== false,
  };
}

export async function findOrCreateUserFromPaypal(profile: PaypalProfile): Promise<{ id: string; email: string; name: string | null }> {
  const byPayer = await query<{ id: string; email: string; name: string | null }>(`SELECT id, email, name FROM users WHERE paypal_payer_id=$1`, [
    profile.payerId,
  ]);
  if (byPayer.rows[0]) {
    if (profile.verified) {
      await query(`UPDATE users SET email_verified_at=COALESCE(email_verified_at,NOW()), updated_at=NOW() WHERE id=$1`, [byPayer.rows[0].id]);
    }
    return byPayer.rows[0];
  }
  const byEmail = await query<{ id: string; email: string; name: string | null }>(`SELECT id, email, name FROM users WHERE LOWER(email)=$1`, [profile.email]);
  if (byEmail.rows[0]) {
    await query(
      `UPDATE users SET paypal_payer_id=$1, name=COALESCE(name,$2), email_verified_at=COALESCE(email_verified_at,${profile.verified ? 'NOW()' : 'NULL'}), updated_at=NOW() WHERE id=$3`,
      [profile.payerId, profile.name, byEmail.rows[0].id],
    );
    return byEmail.rows[0];
  }
  const created = await query<{ id: string; email: string; name: string | null }>(
    `INSERT INTO users (email, name, paypal_payer_id, email_verified_at, updated_at)
     VALUES ($1,$2,$3,${profile.verified ? 'NOW()' : 'NULL'},NOW()) RETURNING id, email, name`,
    [profile.email, profile.name, profile.payerId],
  );
  return created.rows[0];
}
