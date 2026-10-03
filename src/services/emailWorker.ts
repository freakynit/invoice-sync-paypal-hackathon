import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import imaps from 'imap-simple';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

let smtpTransporter: nodemailer.Transporter | null = null;
let imapConnection: any = null;
let timer: NodeJS.Timeout | null = null;
let stopped = true;
let activePoll: Promise<void> | null = null;

function getSmtp(): nodemailer.Transporter {
  if (smtpTransporter) return smtpTransporter;
  smtpTransporter = nodemailer.createTransport({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    secure: config.mail.smtp.secure,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
    auth: { user: config.mail.smtp.email, pass: config.mail.smtp.password },
  });
  smtpTransporter.on('error', (err) => {
    logError('SMTP transport error', { error: String(err?.message ?? err) });
    smtpTransporter = null;
  });
  return smtpTransporter;
}

async function getImap(): Promise<any> {
  if (imapConnection) return imapConnection;
  imapConnection = await imaps.connect({
    imap: {
      user: config.mail.imap.email,
      password: config.mail.imap.password,
      host: config.mail.imap.host,
      port: config.mail.imap.port,
      tls: config.mail.imap.secure,
      authTimeout: config.mail.imap.authTimeout,
      connTimeout: 30000,
      socketTimeout: 60000,
      keepalive: true,
    },
  });
  return imapConnection;
}

async function copyToSent(mailOptions: nodemailer.SendMailOptions): Promise<void> {
  const raw = await new MailComposer(mailOptions).compile().build();
  const conn = await getImap();
  await conn.openBox(config.mail.sentFolderName);
  await conn.append(raw, { mailbox: config.mail.sentFolderName, flags: ['\\Seen'] });
}

function backoffSeconds(attempts: number): number {
  return Math.min(Math.pow(2, attempts), 60);
}

interface EmailRow {
  id: string;
  to_address: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  attempts: number;
  max_attempts: number;
  claim_token: string;
}

async function sendOne(row: EmailRow): Promise<void> {
  const mailOptions: nodemailer.SendMailOptions = {
    from: `${config.mail.fromName} <${config.mail.fromEmail}>`,
    to: row.to_address,
    subject: row.subject,
    html: row.body_html,
    ...(row.body_text ? { text: row.body_text } : {}),
  };
  if (config.app.simulateEmailSending) {
    logInfo('Email simulated', { to: row.to_address, subject: row.subject });
    return;
  }
  await getSmtp().sendMail(mailOptions);
  logInfo('Email sent', { to: row.to_address, subject: row.subject });
  try {
    await copyToSent(mailOptions);
  } catch (err) {
    logWarn('Could not copy to Sent folder', { id: row.id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function markSuccess(row: EmailRow): Promise<void> {
  await pool.query(`UPDATE email_jobs SET status='success', last_error=NULL, claim_token=NULL, updated_at=NOW() WHERE id=$1 AND status='processing' AND claim_token=$2`, [row.id, row.claim_token]);
}

async function markFailure(row: EmailRow, message: string): Promise<void> {
  const attempts = row.attempts + 1;
  const isFinal = attempts >= row.max_attempts;
  const nextAt = new Date(Date.now() + backoffSeconds(attempts) * 1000);
  await pool.query(
    `UPDATE email_jobs SET status=$1, attempts=$2, last_error=$3, next_attempt_at=$4, claim_token=NULL, updated_at=NOW() WHERE id=$5 AND status='processing' AND claim_token=$6`,
    [isFinal ? 'failed' : 'pending', attempts, message, nextAt.toISOString(), row.id, row.claim_token],
  );
  if (isFinal) logError('Email permanently failed', { id: row.id, to: row.to_address });
}

async function sweep(): Promise<void> {
  const client = await pool.connect();
  let rows: EmailRow[] = [];
  const claimToken = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE email_jobs SET
      status=CASE WHEN attempts+1 >= max_attempts THEN 'failed' ELSE 'pending' END,
      attempts=attempts+1, claim_token=NULL, next_attempt_at=NOW(),
      last_error='Email processing lease expired', updated_at=NOW()
      WHERE status='processing' AND updated_at < NOW()-$1 * INTERVAL '1 millisecond'`,
      [config.mail.processingTimeoutMs]);
    const result = await client.query<EmailRow>(
      `SELECT * FROM email_jobs WHERE status='pending' AND next_attempt_at <= NOW() ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [config.mail.batchSize],
    );
    rows = result.rows.map(row => ({ ...row, claim_token: claimToken }));
    if (rows.length === 0) {
      await client.query('COMMIT');
      return;
    }
    await client.query(`UPDATE email_jobs SET status='processing', claim_token=$2, updated_at=NOW() WHERE id = ANY($1::uuid[])`, [
      rows.map((r) => r.id), claimToken,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    logError('Failed to claim pending emails', { error: err instanceof Error ? err.message : String(err) });
    return;
  } finally {
    client.release();
  }

  // Renew all claims, including rows waiting for their concurrency slot.
  const heartbeat = setInterval(() => {
    void pool.query(`UPDATE email_jobs SET updated_at=NOW() WHERE status='processing' AND claim_token=$1`, [claimToken])
      .catch(err => logError('Email claim renewal failed', { error: String(err) }));
  }, Math.floor(config.mail.processingTimeoutMs / 3));
  heartbeat.unref();
  try {
    const concurrency = Math.max(1, Math.floor(config.mail.concurrency));
    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(async (row) => {
        try {
          await sendOne(row);
          await markSuccess(row);
        } catch (err) {
          await markFailure(row, err instanceof Error ? err.message : String(err));
        }
      }));
      for (const result of results) if (result.status === 'rejected') {
        logError('Email job update failed', { error: String(result.reason) });
      }
    }
  } finally { clearInterval(heartbeat); }
}

async function poll(): Promise<void> {
  try {
    await sweep();
  } catch (err) {
    logError('Unexpected email sweep error', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (!stopped) timer = setTimeout(runPoll, config.mail.pollIntervalMs);
  }
}

function runPoll(): void {
  if (stopped || activePoll) return;
  const task = poll();
  activePoll = task;
  void task.finally(() => { if (activePoll === task) activePoll = null; });
}

export function startEmailWorker(): void {
  if (!stopped) return;
  stopped = false;
  timer = setTimeout(runPoll, config.mail.pollIntervalMs);
  logInfo('Email worker started');
}

export async function stopEmailWorker(): Promise<void> {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await activePoll;
  try {
    if (imapConnection) {
      imapConnection.end();
    }
  } catch {
    // ignore
  }
  imapConnection = null;
  if (smtpTransporter) {
    try {
      smtpTransporter.close();
    } catch {
      // ignore
    }
    smtpTransporter = null;
  }
  logInfo('Email worker stopped');
}
