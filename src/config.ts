import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import YAML from 'yaml';

dotenv.config();

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.yaml');

function expandEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_m, name: string, def: string | undefined) => {
      const envVal = process.env[name];
      if (envVal !== undefined && envVal !== '') return envVal;
      if (def !== undefined) return def;
      return '';
    });
  }
  if (Array.isArray(value)) return value.map(expandEnvVars);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnvVars(v);
    return out;
  }
  return value;
}

function toBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return s === '' ? fallback : false;
  }
  return fallback;
}

function toNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function raw(): any {
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = YAML.parse(text);
  return expandEnvVars(parsed) as any;
}

const r = raw();

export interface AppConfig {
  app: { name: string; env: string; publicBaseUrl: string; simulateEmailSending: boolean };
  server: { port: number; host: string; sessionCookieName: string; corsOrigins: string[]; trustProxy: { enabled: boolean; level: number } };
  db: { host: string; port: number; database: string; user: string; password: string; maxPool: number; idleTimeoutMs: number };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    bcryptRounds: number;
    rateLimit: { windowMs: number; loginMax: number; emailMax: number };
    verificationTokenTtlHours: number;
    resetTokenTtlHours: number;
    google: { clientId: string; clientSecret: string; redirectUri: string };
  };
  clerk: { publishableKey: string; secretKey: string };
  mail: {
    fromEmail: string; fromName: string; concurrency: number; sentFolderName: string;
    pollIntervalMs: number; batchSize: number; maxAttempts: number; processingTimeoutMs: number;
    smtp: { host: string; port: number; secure: boolean; email: string; password: string };
    imap: { host: string; port: number; secure: boolean; email: string; password: string; authTimeout: number };
  };
  paypal: { mode: string; clientId: string; clientSecret: string; baseUrl: string; returnUrl: string; lookbackDays: number; pageSize: number; maxPages: number; timeoutMs: number; cacheFreshMinutes: number; cacheRecentDays: number; cacheHistoricalHours: number };
  razorpay: { enabled: boolean; keyId: string; keySecret: string; baseUrl: string; lookbackDays: number; pageSize: number; maxPages: number; timeoutMs: number; cacheFreshMinutes: number; cacheRecentDays: number; cacheHistoricalHours: number };
  drive: { scopes: string[]; supportedMimeTypes: string[]; maxFileBytes: number };
  vllm: { baseUrl: string; apiKey: string; model: string; concurrency: number; maxRetries: number; backoffBaseMs: number; backoffMaxMs: number; timeoutMs: number; httpReferer: string; appTitle: string };
  chat: { baseUrl: string; apiKey: string; model: string; concurrency: number; maxRetries: number; backoffBaseMs: number; backoffMaxMs: number; timeoutMs: number; maxTokens: number; httpReferer: string; appTitle: string };
  demo: { enabled: boolean; email: string; name: string };
  matching: { dateToleranceDays: number; amountTolerance: number; matchedThreshold: number; reviewThreshold: number; ambiguityMargin: number };
  sync: { pollIntervalMs: number; allowedCadences: string[]; cadenceMs: Record<string, number> };
}

export const config: AppConfig = {
  app: {
    name: String(r.app?.name ?? 'Invoice Sync'),
    env: String(r.app?.env ?? 'development'),
    publicBaseUrl: String(r.app?.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, ''),
    simulateEmailSending: toBool(r.app?.simulateEmailSending, false),
  },
  server: {
    trustProxy: {
      enabled: toBool(r.server?.trustProxy?.enabled, false),
      level: Math.max(1, Math.floor(toNum(r.server?.trustProxy?.level, 1))),
    },
    port: toNum(r.server?.port, 3000),
    host: String(r.server?.host ?? '0.0.0.0'),
    sessionCookieName: String(r.server?.sessionCookieName ?? 'invoice_sync_session'),
    corsOrigins: String(r.server?.corsOrigins ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  },
  db: {
    host: String(r.db?.host ?? 'localhost'),
    port: toNum(r.db?.port, 5432),
    database: String(r.db?.database ?? 'invoice_sync'),
    user: String(r.db?.user ?? 'invoice_sync_admin'),
    password: String(r.db?.password ?? ''),
    maxPool: toNum(r.db?.maxPool, 10),
    idleTimeoutMs: toNum(r.db?.idleTimeoutMs, 30000),
  },
  auth: {
    jwtSecret: String(r.auth?.jwtSecret ?? 'change-me'),
    jwtExpiresIn: String(r.auth?.jwtExpiresIn ?? '7d'),
    rateLimit: {
      windowMs: Math.max(1000, toNum(r.auth?.rateLimit?.windowMs, 15 * 60000)),
      loginMax: Math.max(1, Math.floor(toNum(r.auth?.rateLimit?.loginMax, 20))),
      emailMax: Math.max(1, Math.floor(toNum(r.auth?.rateLimit?.emailMax, 5))),
    },
    bcryptRounds: toNum(r.auth?.bcryptRounds, 10),
    verificationTokenTtlHours: toNum(r.auth?.verificationTokenTtlHours, 24),
    resetTokenTtlHours: toNum(r.auth?.resetTokenTtlHours, 1),
    google: {
      clientId: String(r.auth?.google?.clientId ?? ''),
      clientSecret: String(r.auth?.google?.clientSecret ?? ''),
      redirectUri: String(r.auth?.google?.redirectUri ?? 'http://localhost:3000/api/auth/google/callback'),
    },
  },
  clerk: {
    publishableKey: String(r.clerk?.publishableKey ?? ''),
    secretKey: String(r.clerk?.secretKey ?? ''),
  },
  mail: {
    fromEmail: String(r.mail?.fromEmail ?? ''),
    fromName: String(r.mail?.fromName ?? 'Invoice Sync'),
    concurrency: toNum(r.mail?.concurrency, 2),
    sentFolderName: String(r.mail?.sentFolderName ?? 'Sent'),
    pollIntervalMs: toNum(r.mail?.pollIntervalMs, 5000),
    batchSize: toNum(r.mail?.batchSize, 10),
    maxAttempts: toNum(r.mail?.maxAttempts, 8),
    processingTimeoutMs: Math.max(60000, toNum(r.mail?.processingTimeoutMs, 600000)),
    smtp: {
      host: String(r.mail?.smtp?.host ?? ''),
      port: toNum(r.mail?.smtp?.port, 465),
      secure: toBool(r.mail?.smtp?.secure, true),
      email: String(r.mail?.smtp?.email ?? ''),
      password: String(r.mail?.smtp?.password ?? ''),
    },
    imap: {
      host: String(r.mail?.imap?.host ?? ''),
      port: toNum(r.mail?.imap?.port, 993),
      secure: toBool(r.mail?.imap?.secure, true),
      email: String(r.mail?.imap?.email ?? ''),
      password: String(r.mail?.imap?.password ?? ''),
      authTimeout: toNum(r.mail?.imap?.authTimeout, 3000),
    },
  },
  paypal: {
    mode: String(r.paypal?.mode ?? 'sandbox'),
    clientId: String(r.paypal?.clientId ?? ''),
    clientSecret: String(r.paypal?.clientSecret ?? ''),
    baseUrl: String(r.paypal?.baseUrl ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, ''),
    returnUrl: String(r.paypal?.returnUrl ?? 'http://localhost:3000/api/auth/paypal/callback'),
    lookbackDays: toNum(r.paypal?.lookbackDays, 90),
    pageSize: toNum(r.paypal?.pageSize, 100),
    maxPages: Math.max(1, Math.floor(toNum(r.paypal?.maxPages, 50))),
    timeoutMs: toNum(r.paypal?.timeoutMs, 20000),
    cacheFreshMinutes: toNum(r.paypal?.cacheFreshMinutes, 10),
    cacheRecentDays: toNum(r.paypal?.cacheRecentDays, 7),
    cacheHistoricalHours: toNum(r.paypal?.cacheHistoricalHours, 168),
  },
  razorpay: {
    enabled: toBool(r.razorpay?.enabled, true),
    keyId: String(r.razorpay?.keyId ?? ''),
    keySecret: String(r.razorpay?.keySecret ?? ''),
    baseUrl: String(r.razorpay?.baseUrl ?? 'https://api.razorpay.com/v1').replace(/\/$/, ''),
    lookbackDays: toNum(r.razorpay?.lookbackDays, 90),
    pageSize: toNum(r.razorpay?.pageSize, 100),
    maxPages: Math.max(1, Math.floor(toNum(r.razorpay?.maxPages, 200))),
    timeoutMs: toNum(r.razorpay?.timeoutMs, 20000),
    cacheFreshMinutes: toNum(r.razorpay?.cacheFreshMinutes, 10),
    cacheRecentDays: toNum(r.razorpay?.cacheRecentDays, 7),
    cacheHistoricalHours: toNum(r.razorpay?.cacheHistoricalHours, 168),
  },
  drive: {
    scopes: Array.isArray(r.drive?.scopes) ? r.drive.scopes.map(String) : ['https://www.googleapis.com/auth/drive.readonly'],
    supportedMimeTypes: Array.isArray(r.drive?.supportedMimeTypes) ? r.drive.supportedMimeTypes.map(String) : ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
    maxFileBytes: toNum(r.drive?.maxFileBytes, 15 * 1024 * 1024),
  },
  vllm: {
    baseUrl: String(r.vllm?.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    apiKey: String(r.vllm?.apiKey ?? ''),
    model: String(r.vllm?.model ?? ''),
    concurrency: toNum(r.vllm?.concurrency, 3),
    maxRetries: toNum(r.vllm?.maxRetries, 5),
    backoffBaseMs: toNum(r.vllm?.backoffBaseMs, 1000),
    backoffMaxMs: toNum(r.vllm?.backoffMaxMs, 30000),
    timeoutMs: toNum(r.vllm?.timeoutMs, 90000),
    httpReferer: String(r.vllm?.httpReferer ?? ''),
    appTitle: String(r.vllm?.appTitle ?? 'Invoice Sync'),
  },
  chat: {
    baseUrl: String(r.chat?.baseUrl ?? r.vllm?.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    apiKey: String(r.chat?.apiKey ?? r.vllm?.apiKey ?? ''),
    model: String(r.chat?.model ?? 'inclusionai/ling-3.1-flash'),
    concurrency: toNum(r.chat?.concurrency, 2),
    maxRetries: toNum(r.chat?.maxRetries, 3),
    backoffBaseMs: toNum(r.chat?.backoffBaseMs, 1000),
    backoffMaxMs: toNum(r.chat?.backoffMaxMs, 15000),
    timeoutMs: toNum(r.chat?.timeoutMs, 60000),
    maxTokens: Math.max(256, Math.floor(toNum(r.chat?.maxTokens, 1500))),
    httpReferer: String(r.chat?.httpReferer ?? r.vllm?.httpReferer ?? ''),
    appTitle: String(r.chat?.appTitle ?? 'Invoice Sync Chat'),
  },
  demo: {
    enabled: toBool(r.demo?.enabled, true),
    email: String(r.demo?.email ?? 'demo@invoice-sync.local').toLowerCase(),
    name: String(r.demo?.name ?? 'Demo Judge'),
  },
  matching: {
    dateToleranceDays: toNum(r.matching?.dateToleranceDays, 7),
    amountTolerance: toNum(r.matching?.amountTolerance, 0.01),
    matchedThreshold: toNum(r.matching?.matchedThreshold, 60),
    reviewThreshold: toNum(r.matching?.reviewThreshold, 35),
    ambiguityMargin: toNum(r.matching?.ambiguityMargin, 15),
  },
  sync: {
    pollIntervalMs: toNum(r.sync?.pollIntervalMs, 15000),
    allowedCadences: Array.isArray(r.sync?.allowedCadences) ? r.sync.allowedCadences.map(String) : ['none', '1m', '15m', '1h', '4h', '12h', '24h'],
    cadenceMs: (r.sync?.cadenceMs ?? {}) as Record<string, number>,
  },
};

export function isGoogleConfigured(): boolean {
  return Boolean(config.auth.google.clientId && config.auth.google.clientSecret);
}

export function isClerkConfigured(): boolean {
  return Boolean(config.clerk.publishableKey && config.clerk.secretKey);
}

export function isPaypalConfigured(): boolean {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}

export function isChatConfigured(): boolean {
  return Boolean(config.chat.apiKey && config.chat.model);
}

export function isDemoEnabled(): boolean {
  return config.demo.enabled;
}

export function isRazorpayConfigured(): boolean {
  return config.razorpay.enabled && Boolean(config.razorpay.keyId && config.razorpay.keySecret);
}

export function paypalConnectHost(): string {
  return config.paypal.mode === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com';
}
