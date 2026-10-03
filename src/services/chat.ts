import OpenAI from 'openai';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { withRetries } from '../utils/retry.js';
import { logWarn } from '../utils/logger.js';
import { explainInvoice } from './explain.js';

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  answer: string;
  model: string;
  toolCalls: number;
  invoiceIds: string[];
  degraded: boolean;
}

let chatClient: OpenAI | null = null;

function getChatClient(): OpenAI {
  if (chatClient) return chatClient;
  if (!config.chat.apiKey) throw new Error('Chat API key is missing. Set CHAT_API_KEY (reuses the OpenRouter key).');
  chatClient = new OpenAI({
    baseURL: config.chat.baseUrl,
    apiKey: config.chat.apiKey,
    timeout: config.chat.timeoutMs,
    defaultHeaders: {
      ...(config.chat.httpReferer ? { 'HTTP-Referer': config.chat.httpReferer } : {}),
      ...(config.chat.appTitle ? { 'X-Title': config.chat.appTitle } : {}),
    },
  });
  return chatClient;
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'query_invoices',
      description: 'Search the user\'s invoices with match status. Use for "which invoices are overdue/unmatched/needs review", vendor questions (e.g. Acme), and amount lookups.',
      parameters: {
        type: 'object',
        properties: {
          vendor: { type: 'string', description: 'Vendor substring, e.g. Acme' },
          match_status: { type: 'string', enum: ['matched', 'needs_review', 'unmatched', 'any'], description: 'Match status filter' },
          overdue_only: { type: 'boolean', description: 'Only invoices past due_date and not matched' },
          search: { type: 'string', description: 'Free text over invoice number, vendor, file name' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max rows (default 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_payments',
      description: 'Search stored PayPal/Razorpay payments by id, payer, amount or invoice reference.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Transaction id, payer email, invoice number or amount' },
          provider: { type: 'string', enum: ['paypal', 'razorpay', 'any'], description: 'Provider filter' },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Max rows (default 15)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_invoice',
      description: 'Get the match explanation and flags (duplicate, overpayment, currency conflict, overdue) for one invoice id.',
      parameters: {
        type: 'object',
        properties: {
          invoice_id: { type: 'string', description: 'Invoice UUID' },
        },
        required: ['invoice_id'],
      },
    },
  },
];

async function toolQueryInvoices(userId: string, args: Record<string, unknown>): Promise<unknown> {
  const vendor = typeof args.vendor === 'string' ? args.vendor.trim() : '';
  const search = typeof args.search === 'string' ? args.search.trim().slice(0, 200) : '';
  const status = typeof args.match_status === 'string' ? args.match_status : 'any';
  const overdueOnly = args.overdue_only === true;
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 20)) || 20));
  const params: unknown[] = [userId];
  let where = 'WHERE i.user_id=$1';
  if (vendor) {
    params.push(`%${vendor}%`);
    where += ` AND i.vendor_name ILIKE $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (i.invoice_number ILIKE $${params.length} OR i.vendor_name ILIKE $${params.length} OR i.drive_file_name ILIKE $${params.length})`;
  }
  if (status && status !== 'any' && ['matched', 'needs_review', 'unmatched'].includes(status)) {
    params.push(status);
    where += ` AND m.status=$${params.length}`;
  }
  if (overdueOnly) {
    where += ` AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE AND COALESCE(m.status,'unmatched') <> 'matched'`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT i.id, i.invoice_number, i.vendor_name, i.amount, i.currency, i.invoice_date, i.due_date, i.payer_email,
       m.status AS match_status, m.percentage AS match_percentage, m.decision AS match_decision, m.reasons AS match_reasons,
       COALESCE(t.paypal_transaction_id, r.razorpay_payment_id) AS matched_txn_id
     FROM invoices i LEFT JOIN invoice_matches m ON m.invoice_id=i.id
     LEFT JOIN paypal_transactions t ON t.id=m.paypal_transaction_id
     LEFT JOIN razorpay_payments r ON r.id=m.razorpay_payment_id
     ${where} ORDER BY CASE WHEN i.due_date < CURRENT_DATE THEN 0 ELSE 1 END, i.due_date NULLS LAST, i.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function toolQueryPayments(userId: string, args: Record<string, unknown>): Promise<unknown> {
  const search = typeof args.search === 'string' ? args.search.trim().slice(0, 200) : '';
  const provider = typeof args.provider === 'string' ? args.provider : 'any';
  const limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit ?? 15)) || 15));
  const like = search ? `%${search}%` : null;
  const { rows } = await query(
    `SELECT 'paypal' AS provider, t.id, t.paypal_transaction_id AS provider_transaction_id, t.amount, t.currency, t.payer_email,
       t.transaction_initiated_at, t.status FROM paypal_transactions t WHERE t.user_id=$1
       AND ($2::text IS NULL OR t.paypal_transaction_id ILIKE $2 OR COALESCE(t.payer_email,'') ILIKE $2 OR COALESCE(t.amount::text,'') ILIKE $2)
       ${provider === 'paypal' || provider === 'any' ? '' : 'AND FALSE'}
     UNION ALL
     SELECT 'razorpay', r.id, r.razorpay_payment_id, r.amount, r.currency, r.payer_email, r.transaction_initiated_at, r.status
     FROM razorpay_payments r WHERE r.user_id=$1 AND ($3::boolean)
       AND ($2::text IS NULL OR r.razorpay_payment_id ILIKE $2 OR COALESCE(r.payer_email,'') ILIKE $2)
     ORDER BY transaction_initiated_at DESC NULLS LAST LIMIT $4`,
    [userId, like, provider !== 'paypal', limit],
  );
  return rows;
}

async function runTool(userId: string, name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    args = {};
  }
  if (name === 'query_invoices') return JSON.stringify(await toolQueryInvoices(userId, args));
  if (name === 'query_payments') return JSON.stringify(await toolQueryPayments(userId, args));
  if (name === 'explain_invoice') {
    const id = String((args as Record<string, unknown>).invoice_id ?? '');
    if (!id) return JSON.stringify({ error: 'invoice_id is required' });
    try {
      return JSON.stringify(await explainInvoice(userId, id));
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  return JSON.stringify({ error: `Unknown tool ${name}` });
}

/** Deterministic fallback when the chat LLM is unreachable (keeps demo mode usable without keys). */
async function ruleBasedAnswer(userId: string, message: string): Promise<ChatResult> {
  const lower = message.toLowerCase();
  const vendorMatch = lower.match(/(acme|brightline|northwind|dupe|overpay|partial|globex|umbrella)/i);
  const wantsOverdue = /overdue|past due|late|due/.test(lower);
  const wantsUnmatched = /unmatched|unpaid|outstanding|not paid/.test(lower);
  const wantsReview = /review|needs review|ambiguous|flag/.test(lower);
  const vendor = vendorMatch ? vendorMatch[1] : '';
  const status = wantsUnmatched ? 'unmatched' : wantsReview ? 'needs_review' : 'any';
  const rows = (await toolQueryInvoices(userId, { vendor, match_status: status, overdue_only: wantsOverdue && !wantsReview, limit: 20 })) as Array<{
    id: string; invoice_number: string | null; vendor_name: string | null; amount: string | null; currency: string | null;
    due_date: string | null; match_status: string | null; match_percentage: number | null;
  }>;
  const lines = rows.slice(0, 12).map((r) => {
    const due = r.due_date ?? 'no due date';
    const amt = `${r.currency ?? ''} ${r.amount ?? '—'}`;
    return `- ${r.vendor_name ?? 'Invoice'} ${r.invoice_number ?? r.id.slice(0, 8)} — ${amt} — due ${due} — ${r.match_status ?? 'unmatched'} (${r.match_percentage ?? 0}%) [Pay Now: /api/dashboard/invoices/${r.id}/pay]`;
  });
  const scope = `${vendor ? ` for ${vendor}` : ''}${wantsOverdue ? ' that are overdue' : ''}`;
  const answer = rows.length
    ? `Found ${rows.length} invoice(s)${scope} (rule-based answer — chat model unreachable):\n${lines.join('\n')}\n\nOpen an invoice and use **Pay Now** on unmatched rows to create a PayPal order/payout. Use the Explain endpoint for "Matched NN% because …" details.`
    : `No invoices found${scope} (rule-based answer). Try "Which Acme invoices are overdue?" or "Show unmatched invoices".`;
  return { answer, model: 'rule-based-fallback', toolCalls: 0, invoiceIds: rows.map((r) => r.id), degraded: true };
}

export async function runAgentChat(userId: string, message: string, history: ChatHistoryItem[] = []): Promise<ChatResult> {
  const trimmed = message.trim().slice(0, 2000);
  if (!trimmed) throw new Error('Message is required.');
  if (!config.chat.apiKey) return ruleBasedAnswer(userId, trimmed);

  const system = `You are the Invoice Sync reconciliation assistant for the PayPal AI Hackathon.
You help users find invoices, explain matches, and take action.
Rules:
- Use the provided tools (query_invoices, query_payments, explain_invoice) to ground every factual claim in database rows. Never invent invoice numbers, amounts or percentages.
- For "Which Acme invoices are overdue?" call query_invoices with vendor="Acme" and overdue_only=true, then summarize vendor, invoice number, amount, due date, match status.
- Explain matches as "Matched NN% because <signals>" and surface flags verbatim: "Flagged: duplicate, overpayment, currency conflict, overdue & unpaid, ambiguous, missing invoice number, partial/underpayment, pending payment".
- For unmatched/overdue invoices, recommend the Pay Now button (POST /api/dashboard/invoices/:id/pay) which creates a PayPal order (approval link) or payout.
- Keep answers concise markdown with a short list. Include invoice IDs only when the user asks for detail; otherwise invoice numbers are enough.
- If tools return no rows, say so and suggest next steps (run a scan, check filters).`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...history.slice(-10).map((h): OpenAI.Chat.ChatCompletionMessageParam => ({ role: h.role, content: h.content.slice(0, 2000) })),
    { role: 'user', content: trimmed },
  ];

  try {
    let toolCalls = 0;
    const invoiceIds = new Set<string>();
    for (let round = 0; round < 5; round++) {
      const response = await withRetries(
        { maxRetries: config.chat.maxRetries, baseMs: config.chat.backoffBaseMs, maxMs: config.chat.backoffMaxMs, operationName: 'Chat completion' },
        async () => {
          const withTimeout = new Promise<OpenAI.Chat.ChatCompletion>((_, reject) => {
            setTimeout(() => reject(new Error(`Chat timeout after ${config.chat.timeoutMs}ms`)), config.chat.timeoutMs + 5000);
          });
          const call = getChatClient().chat.completions.create({
            model: config.chat.model,
            messages,
            tools: TOOLS,
            tool_choice: 'auto',
            temperature: 0.2,
            max_tokens: config.chat.maxTokens,
          }) as Promise<OpenAI.Chat.ChatCompletion>;
          return (await Promise.race([call, withTimeout])) as OpenAI.Chat.ChatCompletion;
        },
      );
      const choice = response.choices?.[0]?.message;
      if (!choice) throw new Error('Empty chat response');
      const calls = choice.tool_calls ?? [];
      if (!calls.length) {
        const answer = choice.content?.trim() || 'I could not generate an answer.';
        return { answer, model: config.chat.model, toolCalls, invoiceIds: [...invoiceIds], degraded: false };
      }
      messages.push({ role: 'assistant', content: choice.content ?? null, tool_calls: calls } as unknown as OpenAI.Chat.ChatCompletionMessageParam);
      for (const call of calls) {
        if (call.type !== 'function') continue;
        toolCalls++;
        const output = await runTool(userId, call.function.name, call.function.arguments);
        try {
          const parsed = JSON.parse(output) as Array<{ id?: string }> | { invoice?: { id?: string } };
          if (Array.isArray(parsed)) for (const row of parsed) if (row?.id) invoiceIds.add(String(row.id));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const inv = (parsed as { invoice?: { id?: string } }).invoice;
            if (inv?.id) invoiceIds.add(String(inv.id));
          }
        } catch {
          // ignore id extraction errors
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: output.slice(0, 12000) } as unknown as OpenAI.Chat.ChatCompletionMessageParam);
      }
    }
    // Max rounds exhausted: ask for a summary with what we have.
    const finalRes = await getChatClient().chat.completions.create({
      model: config.chat.model,
      messages: [...messages, { role: 'user', content: 'Summarize the tool results concisely in markdown.' }],
      temperature: 0.2,
      max_tokens: config.chat.maxTokens,
    });
    const answer = finalRes.choices?.[0]?.message?.content?.trim() || 'Tool results gathered but summary failed.';
    return { answer, model: config.chat.model, toolCalls, invoiceIds: [...invoiceIds], degraded: false };
  } catch (err) {
    logWarn('Chat LLM failed, using rule-based fallback', { error: err instanceof Error ? err.message : String(err) });
    return ruleBasedAnswer(userId, trimmed);
  }
}
