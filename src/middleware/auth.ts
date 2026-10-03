import type { NextFunction, Request, Response } from 'express';
import { config, isClerkConfigured } from '../config.js';
import { verifySession } from '../utils/auth.js';

export interface AuthedRequest extends Request {
  userId?: string;
  userEmail?: string;
  authMethod?: 'local' | 'clerk';
}

export function getTokenFromRequest(req: Request): string | null {
  const cookie = req.cookies?.[config.server.sessionCookieName];
  if (typeof cookie === 'string' && cookie) return cookie;
  // Clerk's own session cookie (set by ClerkJS on the same origin)
  const clerkSession = req.cookies?.__session;
  if (typeof clerkSession === 'string' && clerkSession) return clerkSession;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function tryClerk(token: string): Promise<{ userId: string; email: string } | null> {
  if (!isClerkConfigured()) return null;
  try {
    const { verifyClerkSessionToken, findOrCreateUserFromClerk } = await import('../services/clerk.js');
    const profile = await verifyClerkSessionToken(token);
    const user = await findOrCreateUserFromClerk(profile);
    return { userId: user.id, email: user.email };
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const payload = verifySession(token);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    req.authMethod = 'local';
    next();
    return;
  } catch {
    // Fall through to Clerk verification below.
  }
  void tryClerk(token)
    .then((clerk) => {
      if (!clerk) {
        res.status(401).json({ error: 'Session expired. Please log in again.' });
        return;
      }
      req.userId = clerk.userId;
      req.userEmail = clerk.email;
      req.authMethod = 'clerk';
      next();
    })
    .catch(() => {
      res.status(401).json({ error: 'Session expired. Please log in again.' });
    });
}

export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  if (token) {
    try {
      const payload = verifySession(token);
      req.userId = payload.userId;
      req.userEmail = payload.email;
      req.authMethod = 'local';
      next();
      return;
    } catch {
      // ignore, try Clerk below
    }
    void tryClerk(token).then((clerk) => {
      if (clerk) {
        req.userId = clerk.userId;
        req.userEmail = clerk.email;
        req.authMethod = 'clerk';
      }
      next();
    });
    return;
  }
  next();
}
