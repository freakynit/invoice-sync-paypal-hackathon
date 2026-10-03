import { createClerkClient, verifyToken } from '@clerk/backend';
import { config, isClerkConfigured } from '../config.js';
import { query } from '../db/pool.js';

export interface ClerkProfile {
  clerkUserId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

function clerkClient() {
  if (!isClerkConfigured()) throw new Error('Clerk is not configured. Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.');
  return createClerkClient({ secretKey: config.clerk.secretKey });
}

/**
 * Verify a Clerk session token, then load the full user profile.
 * The short session JWT only carries `sub`, so one Backend API read
 * fetches the verified primary email.
 */
export async function verifyClerkSessionToken(token: string): Promise<ClerkProfile> {
  const client = clerkClient();
  const claims = await verifyToken(token, { secretKey: config.clerk.secretKey });
  const clerkUserId = String(claims.sub);
  const user = await client.users.getUser(clerkUserId);
  const primaryEmail = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
  if (!primaryEmail?.emailAddress) throw new Error('Clerk account has no email address.');
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
  return {
    clerkUserId,
    email: primaryEmail.emailAddress.toLowerCase(),
    name: fullName,
    avatarUrl: user.imageUrl ?? null,
  };
}

export async function findOrCreateUserFromClerk(profile: ClerkProfile): Promise<{ id: string; email: string; name: string | null }> {
  const byClerk = await query<{ id: string; email: string; name: string | null }>(`SELECT id, email, name FROM users WHERE clerk_user_id=$1`, [
    profile.clerkUserId,
  ]);
  if (byClerk.rows[0]) {
    await query(`UPDATE users SET avatar_url=COALESCE(avatar_url,$1), email_verified_at=COALESCE(email_verified_at,NOW()), updated_at=NOW() WHERE id=$2`, [
      profile.avatarUrl,
      byClerk.rows[0].id,
    ]);
    return byClerk.rows[0];
  }
  const byEmail = await query<{ id: string; email: string; name: string | null }>(`SELECT id, email, name FROM users WHERE LOWER(email)=$1`, [profile.email]);
  if (byEmail.rows[0]) {
    await query(
      `UPDATE users SET clerk_user_id=$1, name=COALESCE(name,$2), avatar_url=COALESCE(avatar_url,$3), email_verified_at=COALESCE(email_verified_at,NOW()), updated_at=NOW() WHERE id=$4`,
      [profile.clerkUserId, profile.name, profile.avatarUrl, byEmail.rows[0].id],
    );
    return byEmail.rows[0];
  }
  const created = await query<{ id: string; email: string; name: string | null }>(
    `INSERT INTO users (email, name, clerk_user_id, avatar_url, email_verified_at, updated_at)
     VALUES ($1,$2,$3,$4,NOW(),NOW()) RETURNING id, email, name`,
    [profile.email, profile.name, profile.clerkUserId, profile.avatarUrl],
  );
  return created.rows[0];
}
