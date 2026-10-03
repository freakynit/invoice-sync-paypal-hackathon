import OpenAI from 'openai';
import pLimit from 'p-limit';
import { config } from '../config.js';
import { parseModelJson } from '../utils/json.js';
import { withRetries } from '../utils/retry.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface ExtractedInvoice {
  invoice_number: string | null;
  vendor: string | null;
  amount: number | null;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
  payer_email: string | null;
  description: string | null;
}

const SYSTEM_PROMPT = `You extract structured data from invoices.
Respond with ONLY a JSON object (no prose). If a field is missing or unreadable, use null.
Schema:
{
  "invoice_number": string | null,
  "vendor": string | null,
  "amount": number | null,
  "currency": string | null,
  "invoice_date": "YYYY-MM-DD" | null,
  "due_date": "YYYY-MM-DD" | null,
  "payer_email": string | null,
  "description": string | null
}
Rules: amount is the grand total as a number (no currency symbols). currency is a 3-letter ISO code (e.g. USD). Dates must be YYYY-MM-DD or null.`;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  if (!config.vllm.apiKey) throw new Error('VLLM API key is missing. Set VLLM_API_KEY.');
  client = new OpenAI({
    baseURL: config.vllm.baseUrl,
    apiKey: config.vllm.apiKey,
    timeout: config.vllm.timeoutMs,
    defaultHeaders: {
      ...(config.vllm.httpReferer ? { 'HTTP-Referer': config.vllm.httpReferer } : {}),
      ...(config.vllm.appTitle ? { 'X-Title': config.vllm.appTitle } : {}),
    },
  });
  return client;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`VLLM timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function coerceExtracted(raw: unknown): ExtractedInvoice {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const cleaned = String(v).replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' || s.toLowerCase() === 'null' ? null : s;
  };
  let currency = str(r.currency);
  if (currency) currency = currency.toUpperCase().slice(0, 3);
  const dateOnly = (v: unknown): string | null => {
    const s = str(v);
    if (!s) return null;
    const m = s.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  };
  return {
    invoice_number: str(r.invoice_number),
    vendor: str(r.vendor),
    amount: num(r.amount ?? (r as Record<string, unknown>).total),
    currency,
    invoice_date: dateOnly(r.invoice_date),
    due_date: dateOnly(r.due_date),
    payer_email: str(r.payer_email),
    description: str(r.description),
  };
}

async function callModel(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<string> {
  return withRetries(
    { maxRetries: config.vllm.maxRetries, baseMs: config.vllm.backoffBaseMs, maxMs: config.vllm.backoffMaxMs, operationName: 'VLLM extract' },
    async () => {
      const response = await withTimeout(
        getClient().chat.completions.create({
          model: config.vllm.model,
          messages,
          temperature: 0,
          max_tokens: 1200,
        }),
        config.vllm.timeoutMs + 5000,
      );
      const content = response.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) {
        const err = new Error('Empty VLLM response') as Error & { status: number };
        err.status = 500;
        throw err;
      }
      return content;
    },
  );
}

export async function extractFromText(text: string): Promise<ExtractedInvoice> {
  const trimmed = text.slice(0, 20000);
  const content = await callModel([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Extract the invoice fields from the text below. Return ONLY JSON.\n\n---\n${trimmed}` },
  ]);
  const parsed = parseModelJson<ExtractedInvoice>(content);
  return coerceExtracted(parsed);
}

export async function extractFromImage(bytes: Buffer, mimeType: string, fileName: string): Promise<ExtractedInvoice> {
  const base64 = bytes.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const content = await callModel([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Extract the invoice fields from this invoice image (${fileName}). Return ONLY JSON. Use null for missing fields.` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]);
  const parsed = parseModelJson<ExtractedInvoice>(content);
  return coerceExtracted(parsed);
}

export async function pdfFirstPageToImage(bytes: Buffer, maxDimension = 2400): Promise<Buffer> {
  const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const loading = getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false,
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts/'),
    cMapUrl: path.join(pdfjsRoot, 'cmaps/'), cMapPacked: true,
  });
  try {
    const document = await loading.promise;
    const page = await document.getPage(1);
    const original = page.getViewport({ scale: 1 });
    // Bound image dimensions even for PDFs with very large page sizes.
    const viewport = page.getViewport({ scale: Math.min(2, maxDimension / Math.max(original.width, original.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as Parameters<typeof page.render>[0]['canvas'], viewport }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await loading.destroy();
  }
}

export async function extractInvoice(bytes: Buffer, mimeType: string, fileName: string): Promise<{ extracted: ExtractedInvoice; rawText: string }> {
  if (mimeType === 'application/pdf') {
    const image = await pdfFirstPageToImage(bytes);
    return { extracted: await extractFromImage(image, 'image/png', fileName + ' (page 1)'), rawText: '' };
  }
  if (mimeType.startsWith('image/')) {
    return { extracted: await extractFromImage(bytes, mimeType, fileName), rawText: '' };
  }
  throw new Error('Only images and PDFs are supported.');
}

export function limitConcurrency(): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = pLimit(Math.max(1, config.vllm.concurrency));
  return <T>(fn: () => Promise<T>) => limit(fn);
}
