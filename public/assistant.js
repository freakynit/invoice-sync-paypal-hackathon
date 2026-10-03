// Invoice Sync assistant: agentic chat, Pay Now, AI explanations, Zapier webhook, demo banner.
// Imported by dashboard.html as an ES module. All network calls go through the
// passed `api` helper so auth/cookies stay consistent.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderInline(text) {
  // `text` is already HTML-escaped. Apply inline markdown: code, bold,
  // italic, strikethrough, links. Code spans are protected via placeholders.
  const codeSpans = [];
  let out = String(text).replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    const safe = /^(https?:\/\/|mailto:|\/|#)/i.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`;
  });
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codeSpans[Number(i)] ?? ''}</code>`);
  return out;
}

function renderMarkdown(text) {
  // Dependency-free markdown viewer for LLM answers: fenced code blocks,
  // headings, hr, blockquotes, tables, ordered/unordered lists, paragraphs.
  const src = String(text ?? '');
  const lines = src.split('\n');
  const html = [];
  const codeBlocks = [];
  // First pass: pull out fenced code blocks so inner markdown is untouched.
  let buf = [];
  let inFence = false;
  let fenceLang = '';
  const blocks = []; // {type:'code',lang,code} or {type:'lines',lines:[]}
  let cur = [];
  for (const line of lines) {
    const m = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (m) {
      if (!inFence) {
        if (cur.length) { blocks.push({ type: 'lines', lines: cur }); cur = []; }
        inFence = true;
        fenceLang = m[1] || '';
        buf = [];
      } else {
        inFence = false;
        blocks.push({ type: 'code', lang: fenceLang, code: buf.join('\n') });
        buf = [];
      }
      continue;
    }
    if (inFence) buf.push(line);
    else cur.push(line);
  }
  if (inFence) blocks.push({ type: 'code', lang: fenceLang, code: buf.join('\n') });
  else if (cur.length) blocks.push({ type: 'lines', lines: cur });

  for (const b of blocks) {
    if (b.type === 'code') {
      codeBlocks.push(b);
      html.push(`\u0000BLOCK${codeBlocks.length - 1}\u0000`);
      continue;
    }
    let i = 0;
    const ls = b.lines;
    let listOpen = null; // 'ul' | 'ol'
    const closeList = () => {
      if (listOpen) { html.push(listOpen === 'ul' ? '</ul>' : '</ol>'); listOpen = null; }
    };
    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    while (i < ls.length) {
      const line = ls[i];
      if (!line.trim()) { closeList(); i++; continue; }
      const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const level = h[1].length;
        html.push(`<h${level}>${renderInline(esc(h[2]))}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); html.push('<hr />'); i++; continue; }
      const q = line.match(/^\s*>\s?(.*)$/);
      if (q) {
        closeList();
        const qs = [];
        while (i < ls.length) {
          const qm = ls[i].match(/^\s*>\s?(.*)$/);
          if (!qm) break;
          qs.push(qm[1]);
          i++;
        }
        html.push(`<blockquote>${qs.map((l) => `<p>${renderInline(esc(l))}</p>`).join('')}</blockquote>`);
        continue;
      }
      // GFM-style table: header | delimiter | rows
      if (isTableRow(line) && i + 1 < ls.length && /^\s*\|?[\s:|-]+\|?[\s:|.-]*$/.test(ls[i + 1]) && isTableRow(ls[i + 1])) {
        closeList();
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < ls.length && isTableRow(ls[i])) { rows.push(cells(ls[i])); i++; }
        html.push(`<table><thead><tr>${head.map((c) => `<th>${renderInline(esc(c))}</th>`).join('')}</tr></thead>`
          + (rows.length ? `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody>` : '')
          + '</table>');
        continue;
      }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const kind = ul ? 'ul' : 'ol';
        if (listOpen !== kind) { closeList(); html.push(kind === 'ul' ? '<ul>' : '<ol>'); listOpen = kind; }
        html.push(`<li>${renderInline(esc((ul || ol)[1]))}</li>`);
        i++;
        continue;
      }
      closeList();
      html.push(`<p>${renderInline(esc(line.trim()))}</p>`);
      i++;
    }
    closeList();
  }
  return html.join('').replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => {
    const blk = codeBlocks[Number(i)];
    if (!blk) return '';
    return `<pre><code>${esc(blk.code)}</code></pre>`;
  });
}

export function initChat({ api, toast }) {
  const list = document.getElementById('chatMessages');
  const input = document.getElementById('chatInput');
  const send = document.getElementById('chatSend');
  const status = document.getElementById('chatStatus');
  const newBtn = document.getElementById('chatNewBtn');
  if (!list || !input || !send) return;
  const history = [];
  let busy = false;
  const WELCOME_HTML = '<p><strong>Hi — I’m your invoice assistant.</strong></p><p>I can search invoices and payments, explain matches, and surface what needs attention. Try an overdue check, an unmatched list, or ask why something needs review.</p><p class="small muted">Unmatched results include a <strong>Pay Now</strong> action (PayPal order or payout).</p>';
  const WELCOME_RAW = 'Hi — I can search your invoices and payments.';

  function timeNow() {
    try {
      return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  function setSuggestsEnabled(enabled) {
    document.querySelectorAll('[data-chat-suggest]').forEach((b) => { b.disabled = !enabled; });
  }

  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch {
      toast('Copy failed — select the text manually.', true);
    }
  }

  function addMessage(role, html, raw) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg is-' + role;
    wrap.innerHTML = `<div class="chat-avatar" aria-hidden="true">${role === 'user' ? 'You' : 'AI'}</div><div><div class="chat-bubble">${html}</div><div class="chat-meta">${esc(timeNow())}</div></div>`;
    if (role === 'assistant' && raw) {
      const bubble = wrap.querySelector('.chat-bubble');
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'chat-copy-btn';
      copy.textContent = '⧉ Copy';
      copy.setAttribute('aria-label', 'Copy message');
      copy.addEventListener('click', () => copyText(raw, copy));
      bubble?.append(copy);
    }
    list.append(wrap);
    list.scrollTop = list.scrollHeight;
    if (raw !== undefined) history.push({ role, content: raw.slice(0, 2000) });
    while (history.length > 20) history.shift();
  }

  function startNewChat() {
    list.innerHTML = '';
    history.length = 0;
    if (status) status.textContent = '';
    if (input) { input.value = ''; input.focus(); }
    addMessage('assistant', WELCOME_HTML, WELCOME_RAW);
  }

  function addPayButtons(invoiceIds) {
    if (!invoiceIds || !invoiceIds.length) return;
    const uniq = [...new Set(invoiceIds)].slice(0, 6);
    const bar = document.createElement('div');
    bar.className = 'chat-actions';
    bar.innerHTML = uniq.map((id) => `<button class="btn btn-primary" data-chat-pay="${esc(id)}">Pay Now · ${esc(String(id).slice(0, 8))}</button>`).join('');
    const last = list.lastElementChild?.querySelector('.chat-bubble');
    if (last) last.append(bar);
    list.scrollTop = list.scrollHeight;
  }

  async function ask(message) {
    const text = (message ?? input.value ?? '').trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    setSuggestsEnabled(false);
    input.value = '';
    addMessage('user', `<p>${esc(text)}</p>`, text);
    if (status) status.textContent = 'Checking invoices, matches and payments…';
    const thinking = document.createElement('div');
    thinking.className = 'chat-msg is-assistant';
    thinking.innerHTML = '<div class="chat-avatar">AI</div><div><div class="chat-bubble"><span class="chat-typing" aria-label="Assistant is typing"><i></i><i></i><i></i></span></div></div>';
    list.append(thinking);
    list.scrollTop = list.scrollHeight;
    try {
      const d = await api('/api/dashboard/chat', { method: 'POST', body: { message: text, history: history.filter((h) => h.role === 'user' || h.role === 'assistant') } });
      thinking.remove();
      addMessage('assistant', renderMarkdown(d.answer || 'No answer.'), String(d.answer || ''));
      if (d.degraded && status) status.textContent = 'Rule-based answer — grounded in your data.';
      else if (status) status.textContent = `Answered · ${d.toolCalls ?? 0} tool call(s) · ${timeNow()}`;
      addPayButtons(d.invoiceIds || []);
    } catch (e) {
      thinking.remove();
      addMessage('assistant', `<p>Chat failed: ${esc(e.message)}</p>`, `Chat failed: ${e.message}`);
      if (status) status.textContent = e.message;
      toast(e.message, true);
    } finally {
      busy = false;
      send.disabled = false;
      setSuggestsEnabled(true);
      input.focus();
    }
  }

  send.addEventListener('click', () => ask());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  newBtn?.addEventListener('click', () => { if (!busy) startNewChat(); });
  document.querySelectorAll('[data-chat-suggest]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.chatSuggest)));
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chat-pay]');
    if (btn) document.dispatchEvent(new CustomEvent('invoice:paynow', { detail: btn.dataset.chatPay }));
  });
  // Welcome message (once)
  if (!list.children.length) {
    addMessage('assistant', WELCOME_HTML, WELCOME_RAW);
  }
  return { ask, newChat: startNewChat };
}

export async function payNowForInvoice(id, { api, toast, refresh }) {
  const invoiceId = String(id);
  const method = window.confirm('Create a PayPal PAYOUT (direct, needs receiver email)?\nOK = Payout · Cancel = Order (approval link).') ? 'payout' : 'order';
  let receiverEmail;
  if (method === 'payout') {
    receiverEmail = window.prompt('Receiver email for the payout (defaults to the invoice payer email):', '') || undefined;
  }
  try {
    toast(`Creating PayPal ${method}…`);
    const d = await api(`/api/dashboard/invoices/${encodeURIComponent(invoiceId)}/pay`, { method: 'POST', body: { method, ...(receiverEmail ? { receiverEmail } : {}) } });
    let extra = '';
    if (d.approvalUrl) {
      extra = ` <a href="${esc(d.approvalUrl)}" target="_blank" rel="noopener">Approve in PayPal ↗</a>`;
      const orderId = d.orderId;
      if (orderId && window.confirm(`Order ${orderId} created.\nAfter approving as a sandbox buyer, capture now?`)) {
        try {
          const c = await api(`/api/dashboard/invoices/${encodeURIComponent(invoiceId)}/pay/capture`, { method: 'POST', body: { orderId } });
          toast(c.message || 'Captured.');
        } catch (e2) { toast(e2.message, true); }
      }
    }
    toast(`${d.message || 'Pay Now created.'}${d.mode === 'demo-simulated' ? ' (demo simulated)' : ''}`);
    const box = document.getElementById('payNowStatus');
    if (box) box.innerHTML = `<div class="paynow-result">${esc(d.message || '')}${extra}</div>`;
    if (refresh) await refresh();
    return d;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

export async function loadExplanation(id, { api }) {
  const box = document.getElementById('invExplanation');
  if (!box) return;
  box.innerHTML = '<div class="small muted"><span class="spinner"></span> Explaining match…</div>';
  try {
    const d = await api(`/api/dashboard/invoices/${encodeURIComponent(id)}/explanation`);
    box.innerHTML = `<div class="explain-headline">🤖 ${esc(d.headline)}</div>`
      + `<p class="small muted">${esc(d.summary)}</p>`
      + (d.signals?.length ? `<div class="signal-list">${d.signals.map((s) => `<span class="signal-match">✓ ${esc(s)}</span>`).join('')}</div>` : '')
      + (d.flags?.length ? `<ul class="candidate-conflicts small">${d.flags.map((f) => `<li><strong>${esc(f.label)}</strong> — ${esc(f.detail)}</li>`).join('')}</ul>` : '<p class="small muted">No flags — clean match.</p>');
  } catch (e) {
    box.innerHTML = `<div class="small muted">Explanation unavailable: ${esc(e.message)}</div>`;
  }
}

export function initWebhook({ api, toast }) {
  const url = document.getElementById('webhookUrl');
  const enabled = document.getElementById('webhookEnabled');
  const status = document.getElementById('webhookStatus');
  const save = document.getElementById('webhookSave');
  const test = document.getElementById('webhookTest');
  if (!url || !save) return;
  async function refresh() {
    try {
      const d = await api('/api/dashboard/webhook');
      url.value = d.url || '';
      if (enabled) enabled.checked = !!d.enabled;
      if (status) status.textContent = d.url ? `${d.enabled ? 'Active' : 'Paused'} · last: ${d.last_status || 'never fired'}` : 'Not configured — paste a Zapier Catch Hook URL.';
    } catch (e) { if (status) status.textContent = e.message; }
  }
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const d = await api('/api/dashboard/webhook', { method: 'PUT', body: { url: url.value.trim() || null, enabled: enabled ? enabled.checked : true } });
      toast(d.message || 'Webhook saved.');
      refresh();
    } catch (e) { toast(e.message, true); }
    finally { save.disabled = false; }
  });
  if (test) test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const d = await api('/api/dashboard/webhook/test', { method: 'POST', body: {} });
      toast(d.message || 'Test sent.');
      refresh();
    } catch (e) { toast(e.message, true); }
    finally { test.disabled = false; }
  });
  refresh();
  return { refresh };
}

export function showDemoBanner(isDemo) {
  let banner = document.getElementById('demoBanner');
  if (!banner) return;
  banner.hidden = !isDemo;
  if (isDemo) {
    banner.innerHTML = '<strong>Demo mode</strong><span>Play around with realistic simulated invoices and payments to explore the platform</span><span style="flex:1"></span><button class="btn btn-ghost" id="demoResetBtn">Reset demo data</button>';
    document.getElementById('demoResetBtn')?.addEventListener('click', async () => {
      try {
        const { api, toast } = await import('/app.js');
        await api('/api/auth/demo/reset', { method: 'POST', body: {} });
        toast('Demo workspace reset.');
        window.location.reload();
      } catch (e) {
        const { toast } = await import('/app.js');
        toast(e.message, true);
      }
    });
  }
}
