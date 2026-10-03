import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/** Shared counters survive restarts and apply across server instances. */
export const authRateLimit: RequestHandler = async (req, res, next) => {
  const login = req.path === '/login';
  const scope = login ? 'login' : 'email';
  const max = login ? config.auth.rateLimit.loginMax : config.auth.rateLimit.emailMax;
  const identities = [`ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`];
  if (typeof req.body?.email === 'string') identities.push(`email:${req.body.email.trim().toLowerCase()}`);
  try {
    await query('DELETE FROM auth_rate_limits WHERE expires_at <= NOW()');
    for (const identity of identities) {
      const key = createHash('sha256').update(`${scope}:${identity}`).digest('hex');
      const { rows } = await query<{ hits: number; retry_after: number }>(
        `INSERT INTO auth_rate_limits (key,hits,expires_at) VALUES ($1,1,NOW()+$2 * INTERVAL '1 millisecond')
         ON CONFLICT (key) DO UPDATE SET
           hits=CASE WHEN auth_rate_limits.expires_at <= NOW() THEN 1 ELSE auth_rate_limits.hits+1 END,
           expires_at=CASE WHEN auth_rate_limits.expires_at <= NOW() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END
         RETURNING hits, GREATEST(1,CEIL(EXTRACT(EPOCH FROM expires_at-NOW())))::int AS retry_after`,
        [key, config.auth.rateLimit.windowMs]);
      if (rows[0].hits > max) {
        res.setHeader('Retry-After', rows[0].retry_after);
        res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        return;
      }
    }
    next();
  } catch (err) { next(err); }
};
