import { logWarn } from './logger.js';

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as Record<string, unknown>;
  const status = Number((anyErr as { status?: unknown }).status ?? (anyErr as { response?: { status?: unknown } }).response?.status ?? NaN);
  if (Number.isFinite(status) && isRetryableStatus(status)) return true;
  const code = String((anyErr as { code?: unknown }).code ?? (anyErr as { cause?: { code?: unknown } }).cause?.code ?? '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code)) return true;
  const message = String((anyErr as { message?: unknown }).message ?? '');
  if (/429|rate limit|temporarily|timeout|5\d\d/i.test(message)) return true;
  return false;
}

export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * 0.2 * Math.random();
  return Math.round(capped + jitter);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries: number;
  baseMs: number;
  maxMs: number;
  operationName: string;
}

export async function withRetries<T>(options: RetryOptions, fn: (attempt: number) => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const shouldRetry = attempt < options.maxRetries && isRetryableError(err);
      if (!shouldRetry) throw err;
      const delay = backoffDelayMs(attempt, options.baseMs, options.maxMs);
      logWarn(`${options.operationName} failed (attempt ${attempt + 1}), retrying`, {
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}
