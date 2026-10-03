// Shared frontend helpers for Invoice Sync.
export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body !== undefined && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

export function toast(msg, isErr = false) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast-item' + (isErr ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

export function showFormError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
}

export function showFormOk(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function money(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const cur = currency || '';
  return `${cur ? cur + ' ' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function statusChip(status) {  const map = {
    matched: ['Matched', 'chip-pos'],
    needs_review: ['Needs review', 'chip-warn'],
    unmatched: ['Unmatched', 'chip-neutral'],
    extracted: ['Extracted', 'chip-info'],
    pending: ['Pending', 'chip-neutral'],
    failed: ['Failed', 'chip-neg'],
    running: ['Running', 'chip-info'],
    cancelling: ['Cancelling', 'chip-warn'],
    cancelled: ['Cancelled', 'chip-neutral'],
    success: ['Success', 'chip-pos'],
    s: ['Success', 'chip-pos'],
    p: ['Pending', 'chip-warn'],
    d: ['Denied', 'chip-neg'],
    v: ['Reversed', 'chip-neg'],
    completed: ['Completed', 'chip-pos'],
    captured: ['Captured', 'chip-pos'],
    authorized: ['Authorized', 'chip-info'],
    created: ['Created', 'chip-neutral'],
    refunded: ['Refunded', 'chip-warn'],
  };
  const [label, cls] = map[status] || [status, 'chip-neutral'];
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

// Simple visible redirect timer: "Taking you to <label> in Ns…"
// Shows a live countdown inside `targetId` (defaults to the #ok box),
// then navigates to `url`. Returns a cancel function.
export function redirectWithCountdown(url, { seconds = 5, targetId = 'ok', label = 'login' } = {}) {
  const el = document.getElementById(targetId);
  let remaining = Math.max(1, Math.round(seconds));
  let timer = null;
  const render = () => {
    if (el) {
      el.style.display = 'block';
      el.innerHTML = '';
      const msg = document.createElement('span');
      msg.textContent = `Taking you to ${label} in ${remaining}s… `;
      const link = document.createElement('a');
      link.href = url;
      link.textContent = 'Go now';
      link.style.fontWeight = '700';
      el.appendChild(msg);
      el.appendChild(link);
    }
  };
  render();
  timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      window.location.href = url;
      return;
    }
    render();
  }, 1000);
  return () => clearInterval(timer);
}
