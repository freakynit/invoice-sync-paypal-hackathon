import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';

export function emailTemplate(title: string, heading: string, bodyHtml: string, cta?: { label: string; href: string }, note?: string): { html: string; text: string } {
  const appName = config.app.name;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f3f0;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f0;padding:32px 16px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e4e3e0;border-radius:12px;overflow:hidden;max-width:520px;">
<tr><td style="background:#111010;padding:20px 32px;color:#fff;font-size:20px;font-weight:700;">${appName}</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;margin:0 0 8px;">${title}</p>
<h1 style="font-size:24px;margin:0 0 12px;color:#111;">${heading}</h1>
<div style="font-size:14px;line-height:1.7;color:#2a2929;">${bodyHtml}</div>
${cta ? `<p style="text-align:center;margin:28px 0 8px;"><a href="${cta.href}" style="display:inline-block;background:#111010;color:#fff;text-decoration:none;padding:13px 32px;border-radius:7px;font-weight:600;">${cta.label}</a></p>` : ''}
${cta ? `<p style="font-size:11px;color:#9b9b9b;word-break:break-all;">${cta.href}</p>` : ''}
${note ? `<p style="font-size:12px;color:#6b6b6b;background:#f4f3f0;border-radius:7px;padding:10px 14px;">${note}</p>` : ''}
</td></tr>
<tr><td style="background:#fafaf8;border-top:1px solid #e4e3e0;padding:16px 32px;font-size:11px;color:#9b9b9b;text-align:center;">&copy; 2026 ${appName}. All rights reserved.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  const text = `${appName} — ${heading}\n\n${bodyHtml.replace(/<[^>]+>/g, '')}\n${cta ? `\n${cta.label}: ${cta.href}` : ''}`;
  return { html, text };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function queueEmail(to: string, subject: string, html: string, text?: string): Promise<void> {
  await query(`INSERT INTO email_jobs (to_address, subject, body_html, body_text) VALUES ($1, $2, $3, $4)`, [
    to.trim().toLowerCase(),
    subject,
    html,
    text ?? null,
  ]);
}

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.auth.verificationTokenTtlHours * 3600 * 1000);
  await query(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    userId,
    sha256(raw),
    expiresAt.toISOString(),
  ]);
  return raw;
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.auth.resetTokenTtlHours * 3600 * 1000);
  await query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    userId,
    sha256(raw),
    expiresAt.toISOString(),
  ]);
  return raw;
}

export function hashToken(raw: string): string {
  return sha256(raw);
}

export async function sendVerificationEmail(to: string, link: string): Promise<void> {
  const { html, text } = emailTemplate(
    'Verify email',
    'One click to get started.',
    `<p>Hi there,</p><p>You recently created an account on <strong>${config.app.name}</strong>. Click below to verify your email address.</p>`,
    { label: 'Verify my email →', href: link },
    'Link expires in 24 hours. If this was not you, ignore this email.',
  );
  await queueEmail(to, `Verify your email — ${config.app.name}`, html, text);
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<void> {
  const { html, text } = emailTemplate(
    'Reset password',
    'Reset your password.',
    `<p>Hi there,</p><p>We received a request to reset your <strong>${config.app.name}</strong> password. Click below to choose a new one.</p>`,
    { label: 'Reset password →', href: link },
    'Link expires in 1 hour. If you did not request this, ignore this email.',
  );
  await queueEmail(to, `Reset your password — ${config.app.name}`, html, text);
}

export async function sendScanReportEmail(to: string, stats: { filesNew: number; filesRescanned: number; matched: number; review: number; unmatched: number }): Promise<void> {
  const { html, text } = emailTemplate(
    'Scan complete',
    'Your invoice scan is complete.',
    `<p>New invoices: <strong>${stats.filesNew}</strong><br>Re-scanned: <strong>${stats.filesRescanned}</strong><br>Matched: <strong>${stats.matched}</strong> · Needs review: <strong>${stats.review}</strong> · Unmatched: <strong>${stats.unmatched}</strong></p><p>Open your dashboard to review the report.</p>`,
    { label: 'Open dashboard →', href: `${config.app.publicBaseUrl}/dashboard` },
  );
  await queueEmail(to, `Scan complete — ${config.app.name}`, html, text);
}
