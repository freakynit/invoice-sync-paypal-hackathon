import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function signSession(payload: { userId: string; email: string }): string {
  return jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn as unknown as jwt.SignOptions['expiresIn'],
  });
}

export function verifySession(token: string): { userId: string; email: string } {
  const decoded = jwt.verify(token, config.auth.jwtSecret) as { userId: string; email: string };
  return { userId: decoded.userId, email: decoded.email };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  const value = email.trim();
  if (value.length === 0 || value.length > 254) return false;
  if (!EMAIL_RE.test(value)) return false;
  const [local, domain] = value.split('@');
  if (!local || !domain) return false;
  if (local.length > 64) return false;
  if (local.includes('..') || domain.includes('..')) return false;
  return true;
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 72;
}
