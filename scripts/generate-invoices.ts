#!/usr/bin/env node

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  out: path.resolve(scriptDir, '../sample-invoices'),
  count: 8,
  seed: 42,
  format: 'png',
  style: 'all',
};

type Style = 'modern' | 'classic' | 'receipt' | 'minimal' | 'ledger';
type StyleOption = Style | 'all';
type Vendor = { name: string; address: string[]; email: string; currency: string; symbol: string; tax: number };
type Customer = { name: string; lines: string[] };
type LineItem = { description: string; detail: string; qty: number; unit: number };
type Palette = { ink: string; accent: string; soft: string; rule: string; muted: string };
type MissingFields = { dueDate: boolean; payerEmail: boolean };
type InvoiceRecord = {
  width: number;
  height: number;
  vendor: Vendor;
  customer: Customer;
  items: LineItem[];
  invoiceNo: string;
  dates: ReturnType<typeof dateStrings>;
  taxRate: number;
  style: Style;
  missing: MissingFields;
  payerEmail: string;
};

const vendors: Vendor[] = [
  { name: 'Northstar Studio', address: ['44 King Street West', 'Toronto, ON M5H 1H1, Canada'], email: 'billing@northstar.example', currency: 'CAD', symbol: 'CA$', tax: 13 },
  { name: 'Juniper & Co.', address: ['18 Rue de la Paix', '75002 Paris, France'], email: 'comptabilite@juniper.example', currency: 'EUR', symbol: '€', tax: 20 },
  { name: 'Brightline Systems', address: ['720 Market Street, Suite 410', 'San Francisco, CA 94103, USA'], email: 'accounts@brightline.example', currency: 'USD', symbol: '$', tax: 8.625 },
  { name: 'Harbor Paper Goods', address: ['9 Bridge Road', 'Bristol BS1 4EF, United Kingdom'], email: 'finance@harborpaper.example', currency: 'GBP', symbol: '£', tax: 20 },
  { name: 'Kite & Key Design', address: ['62 Collins Street', 'Melbourne VIC 3000, Australia'], email: 'hello@kitekey.example', currency: 'AUD', symbol: 'A$', tax: 10 },
  { name: 'Cedar Peak Consulting', address: ['1050 West Pender Street', 'Vancouver, BC V6E 3S7, Canada'], email: 'invoices@cedarpeak.example', currency: 'CAD', symbol: 'CA$', tax: 5 },
  { name: 'Morrow Cloud Services', address: ['31 Market Square', 'Dublin D02 XH96, Ireland'], email: 'receivables@morrowcloud.example', currency: 'EUR', symbol: '€', tax: 23 },
  { name: 'Fieldnote Supply', address: ['204 Pine Avenue', 'Portland, OR 97204, USA'], email: 'billing@fieldnote.example', currency: 'USD', symbol: '$', tax: 0 },
];

const customers: Customer[] = [
  { name: 'Avery Morgan', lines: ['Morgan Workshop', '88 Queen Street, Toronto, ON M5C 1S1'] },
  { name: 'Lena Fischer', lines: ['Atelier Fischer', '6 Avenue Victor Hugo, 75016 Paris'] },
  { name: 'Summit Trail Foods', lines: ['Attn: Priya Shah', '220 2nd Street, San Francisco, CA 94105'] },
  { name: 'Oliver Grant', lines: ['Grant & Sons', '14 Gloucester Road, Bristol BS7 8AA'] },
  { name: 'Mia Chen', lines: ['Chen Retail Group', '17 Little Collins Street, Melbourne VIC 3000'] },
  { name: 'Lakeview Analytics', lines: ['Attn: Sam Patel', '510 Burrard Street, Vancouver, BC V6C 3A8'] },
  { name: 'Rowan Digital Ltd.', lines: ['Attn: Emma Walsh', '12 Harcourt Street, Dublin D02 XY45'] },
  { name: 'Fern & Finch Market', lines: ['Attn: Jordan Lee', '402 NW 10th Avenue, Portland, OR 97209'] },
];

const lineItems: LineItem[][] = [
  [
    { description: 'Brand identity and visual system', detail: 'Project package · 1 delivery', qty: 1, unit: 1480 },
    { description: 'Print-ready stationery artwork', detail: 'Business cards and letterhead', qty: 2, unit: 185 },
  ],
  [
    { description: 'Cloud workspace subscription', detail: 'Annual plan · 12 months', qty: 12, unit: 42 },
    { description: 'Onboarding and data migration', detail: 'One-time service', qty: 1, unit: 390 },
  ],
  [
    { description: 'Consulting services', detail: 'Strategy and implementation', qty: 8, unit: 165 },
    { description: 'Travel expenses', detail: 'Client workshop · 16 Sep', qty: 1, unit: 124.5 },
  ],
  [
    { description: 'Recycled kraft notebooks', detail: 'Pack of 10 · SKU NB-204', qty: 6, unit: 38.5 },
    { description: 'Express shipping', detail: 'Tracked delivery', qty: 1, unit: 24 },
  ],
  [
    { description: 'Product photography', detail: 'Edited high-resolution images', qty: 1, unit: 960 },
    { description: 'Studio rental', detail: 'Half-day booking', qty: 1, unit: 275 },
  ],
  [
    { description: 'Quarterly reporting package', detail: 'Q3 2026 · 3 business units', qty: 1, unit: 1275 },
    { description: 'Additional analysis hours', detail: 'Research and recommendations', qty: 3, unit: 145 },
  ],
  [
    { description: 'Website maintenance', detail: 'September 2026 · monthly service', qty: 1, unit: 620 },
    { description: 'Accessibility review', detail: 'Audit and written report', qty: 1, unit: 310 },
  ],
  [
    { description: 'Market stall display set', detail: 'Modular counter and signage', qty: 1, unit: 840 },
    { description: 'Packaging materials', detail: 'Recycled mailers · carton of 50', qty: 4, unit: 31.25 },
  ],
];

const styles: Style[] = ['modern', 'classic', 'receipt', 'minimal', 'ledger', 'modern', 'classic', 'receipt'];
const palette: Record<Style, Palette> = {
  modern: { ink: '#172554', accent: '#2563eb', soft: '#eff6ff', rule: '#dbe4f0', muted: '#64748b' },
  classic: { ink: '#252525', accent: '#8b5e3c', soft: '#f7f3ee', rule: '#d9d2c8', muted: '#6b6259' },
  receipt: { ink: '#202020', accent: '#202020', soft: '#f5f5f2', rule: '#c9c9c4', muted: '#555' },
  minimal: { ink: '#193d37', accent: '#17806e', soft: '#eaf5f1', rule: '#d6e5df', muted: '#65756f' },
  ledger: { ink: '#402a68', accent: '#7351a6', soft: '#f3eff8', rule: '#ddd4eb', muted: '#756c80' },
};

function parseArgs(argv: string[]) {
  const options: { out: string; count: string | number; seed: string | number; format: string; style: string; manifest?: string } = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`Generate synthetic invoice images.\n\nUsage: npm run generate:invoices -- [options]\n\nOptions:\n  --out <directory>       Output directory (default: sample-invoices)\n  --count <number>        Number of invoices, 1–100 (default: 8)\n  --seed <number>         Starting record/style offset (default: 42)\n  --format <png|jpeg>     Image format (default: png)\n  --style <name|all>      modern, classic, receipt, minimal, ledger, or all\n  --manifest <file>       Render every invoice case from a PayPal seed manifest\n  -h, --help              Show this help`);
      process.exit(0);
    }
    if (!['--out', '--count', '--seed', '--format', '--style', '--manifest'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${arg}`);
    switch (arg) {
      case '--manifest': options.manifest = path.resolve(value); break;
      case '--out': options.out = value; break;
      case '--count': options.count = value; break;
      case '--seed': options.seed = value; break;
      case '--format': options.format = value; break;
      case '--style': options.style = value; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  options.count = Number(options.count);
  options.seed = Number(options.seed);
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 100) throw new Error('--count must be an integer from 1 to 100');
  if (!Number.isInteger(options.seed) || options.seed < 0) throw new Error('--seed must be a non-negative integer');
  options.format = String(options.format).toLowerCase().replace(/^jpg$/, 'jpeg');
  if (!['png', 'jpeg'].includes(options.format)) throw new Error('--format must be png or jpeg');
  if (!['all', ...Object.keys(palette)].includes(options.style)) throw new Error(`Unknown --style: ${options.style}`);
  options.out = path.resolve(options.out);
  return { ...options, count: options.count as number, seed: options.seed as number, format: options.format as 'png' | 'jpeg', style: options.style as StyleOption };
}

function money(amount: number, vendor: Vendor): string {
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${vendor.symbol}${formatted}`;
}

function dateStrings(index: number) {
  const day = 2 + ((index * 3) % 23);
  const invoiceDate = new Date(Date.UTC(2026, 8, day));
  const dueDate = new Date(Date.UTC(2026, 9, day + 14));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const us = (date: Date) => `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
  const eu = (date: Date) => `${String(date.getUTCDate()).padStart(2, '0')} ${date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${date.getUTCFullYear()}`;
  return { invoiceDate: index % 2 ? eu(invoiceDate) : us(invoiceDate), dueDate: index % 2 ? iso(dueDate) : us(dueDate), isoDate: iso(invoiceDate) };
}

function text(ctx: SKRSContext2D, value: string | number, x: number, y: number, size = 22, color = '#222', weight = '400', align: CanvasTextAlign = 'left', family = 'Arial') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = align;
  ctx.fillText(String(value), x, y);
}

function line(ctx: SKRSContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, radius: number, fill: string, stroke?: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function header(ctx: SKRSContext2D, style: Style, vendor: Vendor, invoiceNo: string, width: number, p: Palette) {
  if (style === 'modern') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, 0, width, 18);
    roundRect(ctx, 64, 66, 66, 66, 18, p.soft);
    text(ctx, vendor.name.slice(0, 1), 97, 111, 38, p.accent, '700', 'center');
    text(ctx, vendor.name, 154, 91, 28, p.ink, '700');
    text(ctx, vendor.address.join(' · '), 154, 122, 15, p.muted);
    text(ctx, 'INVOICE', width - 64, 92, 38, p.ink, '700', 'right');
    text(ctx, invoiceNo, width - 64, 125, 18, p.muted, '400', 'right');
    line(ctx, 64, 164, width - 64, 164, p.rule, 2);
  } else if (style === 'classic') {
    text(ctx, vendor.name.toUpperCase(), 500, 90, 28, p.ink, '700', 'center', 'Georgia');
    text(ctx, vendor.address.join('  •  '), 500, 123, 15, p.muted, '400', 'center', 'Georgia');
    line(ctx, 80, 158, 920, 158, p.accent, 2);
    text(ctx, 'INVOICE', 80, 215, 34, p.ink, '700', 'left', 'Georgia');
    text(ctx, invoiceNo, 920, 210, 19, p.muted, '400', 'right', 'Georgia');
    line(ctx, 80, 234, 920, 234, p.rule, 1);
  } else if (style === 'minimal') {
    text(ctx, vendor.name, 80, 93, 30, p.ink, '500');
    text(ctx, 'INVOICE', 920, 93, 23, p.accent, '700', 'right');
    text(ctx, vendor.address.join(' · '), 80, 128, 16, p.muted);
    text(ctx, invoiceNo, 920, 128, 16, p.muted, '400', 'right');
    line(ctx, 80, 164, 920, 164, p.rule, 2);
  } else if (style === 'ledger') {
    roundRect(ctx, 72, 60, 856, 110, 12, p.soft);
    text(ctx, vendor.name, 100, 105, 29, p.ink, '700');
    text(ctx, vendor.address.join(' · '), 100, 138, 15, p.muted);
    text(ctx, 'Invoice', 892, 103, 24, p.accent, '700', 'right');
    text(ctx, invoiceNo, 892, 139, 17, p.ink, '400', 'right');
    line(ctx, 72, 193, 928, 193, p.accent, 3);
  }
}

function details(ctx: SKRSContext2D, style: Style, customer: Customer & { email: string }, invoiceNo: string, dates: ReturnType<typeof dateStrings>, vendor: Vendor, width: number, p: Palette, missing: MissingFields) {
  if (style === 'receipt') return;
  const y = style === 'classic' ? 286 : 238;
  const pad = style === 'minimal' ? 80 : 64;
  text(ctx, 'BILL TO', pad, y, 14, p.muted, '700');
  text(ctx, customer.name, pad, y + 34, 21, p.ink, '700');
  customer.lines.forEach((v, i) => text(ctx, v, pad, y + 62 + i * 24, 16, p.muted));
  const colX = width - pad;
  text(ctx, 'INVOICE NUMBER', colX, y, 13, p.muted, '700', 'right');
  text(ctx, invoiceNo, colX, y + 28, 17, p.ink, '500', 'right');
  text(ctx, 'INVOICE DATE', colX, y + 62, 13, p.muted, '700', 'right');
  text(ctx, dates.invoiceDate, colX, y + 88, 16, p.ink, '400', 'right');
  if (!missing.dueDate) {
    text(ctx, 'DUE DATE', colX, y + 122, 13, p.muted, '700', 'right');
    text(ctx, dates.dueDate, colX, y + 148, 16, p.ink, '400', 'right');
  }
  if (!missing.payerEmail) text(ctx, `Contact: ${customer.email}`, pad, y + 118, 14, p.muted);
  line(ctx, pad, y + 178, width - pad, y + 178, p.rule, 1);
}

function drawStandard(ctx: SKRSContext2D, style: Style, record: InvoiceRecord, p: Palette, missing: MissingFields) {
  const { width, height, vendor, customer, invoiceNo, items, dates, taxRate } = record;
  header(ctx, style, vendor, invoiceNo, width, p);
  details(ctx, style, { ...customer, email: record.payerEmail }, invoiceNo, dates, vendor, width, p, missing);
  const pad = style === 'minimal' ? 80 : (style === 'classic' ? 80 : 64);
  const tableY = style === 'classic' ? 492 : 443;
  const tableW = width - pad * 2;
  ctx.fillStyle = p.soft;
  ctx.fillRect(pad, tableY, tableW, 48);
  text(ctx, 'DESCRIPTION', pad + 14, tableY + 31, 14, p.muted, '700');
  text(ctx, 'QTY', width - pad - 250, tableY + 31, 14, p.muted, '700', 'right');
  text(ctx, 'UNIT PRICE', width - pad - 130, tableY + 31, 14, p.muted, '700', 'right');
  text(ctx, 'AMOUNT', width - pad - 14, tableY + 31, 14, p.muted, '700', 'right');
  let subtotal = 0;
  items.forEach((item, i) => {
    const rowY = tableY + 95 + i * 86;
    const amount = item.qty * item.unit;
    subtotal += amount;
    text(ctx, item.description, pad + 14, rowY, 17, p.ink, '500');
    text(ctx, item.detail, pad + 14, rowY + 27, 13, p.muted);
    text(ctx, item.qty, width - pad - 250, rowY + 4, 16, p.ink, '400', 'right');
    text(ctx, money(item.unit, vendor), width - pad - 130, rowY + 4, 15, p.ink, '400', 'right');
    text(ctx, money(amount, vendor), width - pad - 14, rowY + 4, 16, p.ink, '500', 'right');
    line(ctx, pad, rowY + 43, width - pad, rowY + 43, p.rule, 1);
  });
  const tax = Math.round(subtotal * taxRate) / 100;
  const totalsY = tableY + 290;
  const right = width - pad - 14;
  text(ctx, 'Subtotal', width - pad - 250, totalsY, 16, p.muted);
  text(ctx, money(subtotal, vendor), right, totalsY, 16, p.ink, '400', 'right');
  text(ctx, `Tax (${taxRate}%)`, width - pad - 250, totalsY + 36, 16, p.muted);
  text(ctx, money(tax, vendor), right, totalsY + 36, 16, p.ink, '400', 'right');
  roundRect(ctx, width - pad - 370, totalsY + 57, 370, 66, 8, p.soft);
  text(ctx, 'TOTAL DUE', width - pad - 350, totalsY + 98, 15, p.ink, '700');
  text(ctx, money(subtotal + tax, vendor), right - 10, totalsY + 100, 24, p.accent, '700', 'right');
  const footerY = height - 75;
  line(ctx, pad, footerY - 27, width - pad, footerY - 27, p.rule, 1);
  text(ctx, missing.dueDate ? 'Thank you for your business.' : `Please remit payment by ${dates.dueDate}. Thank you for your business.`, pad, footerY, 14, p.muted);
  if (!missing.payerEmail) text(ctx, `Questions? ${record.payerEmail}`, width - pad, footerY, 14, p.muted, '400', 'right');
}

function drawReceipt(ctx: SKRSContext2D, record: InvoiceRecord, p: Palette, missing: MissingFields) {
  const { width, height, vendor, customer, invoiceNo, items, dates, taxRate } = record;
  const center = width / 2;
  text(ctx, vendor.name, center, 88, 31, p.ink, '700', 'center');
  vendor.address.forEach((v, i) => text(ctx, v, center, 122 + i * 23, 15, p.muted, '400', 'center'));
  line(ctx, 50, 184, width - 50, 184, p.rule, 2);
  text(ctx, 'INVOICE', center, 231, 26, p.ink, '700', 'center');
  text(ctx, invoiceNo, center, 263, 17, p.muted, '400', 'center');
  text(ctx, `Date: ${dates.invoiceDate}`, 60, 315, 16, p.ink);
  if (!missing.dueDate) text(ctx, `Due: ${dates.dueDate}`, 60, 344, 16, p.ink);
  text(ctx, 'BILL TO', 60, 401, 13, p.muted, '700');
  text(ctx, customer.name, 60, 430, 17, p.ink, '700');
  customer.lines.forEach((v, i) => text(ctx, v, 60, 456 + i * 22, 14, p.muted));
  if (!missing.payerEmail) text(ctx, record.payerEmail, 60, 515, 13, p.muted);
  line(ctx, 50, 555, width - 50, 555, p.rule, 1,);
  let subtotal = 0;
  items.forEach((item, i) => {
    const y = 604 + i * 98;
    const amount = item.qty * item.unit;
    subtotal += amount;
    text(ctx, item.description, 60, y, 16, p.ink, '500');
    text(ctx, `${item.qty} × ${money(item.unit, vendor)}`, 60, y + 27, 14, p.muted);
    text(ctx, money(amount, vendor), width - 60, y + 27, 16, p.ink, '500', 'right');
    line(ctx, 60, y + 49, width - 60, y + 49, p.rule, 1);
  });
  const tax = Math.round(subtotal * taxRate) / 100;
  const totalsY = 825;
  text(ctx, 'Subtotal', 60, totalsY, 15, p.muted);
  text(ctx, money(subtotal, vendor), width - 60, totalsY, 15, p.ink, '400', 'right');
  text(ctx, `Tax ${taxRate}%`, 60, totalsY + 32, 15, p.muted);
  text(ctx, money(tax, vendor), width - 60, totalsY + 32, 15, p.ink, '400', 'right');
  line(ctx, 60, totalsY + 53, width - 60, totalsY + 53, p.ink, 2);
  text(ctx, 'TOTAL', 60, totalsY + 91, 18, p.ink, '700');
  text(ctx, money(subtotal + tax, vendor), width - 60, totalsY + 91, 22, p.ink, '700', 'right');
  text(ctx, 'Payment due upon receipt', center, height - 85, 15, p.muted, '400', 'center');
  text(ctx, 'Thank you!', center, height - 52, 17, p.accent, '700', 'center');
}

function makeRecord(index: number, seed: number, style: Style): InvoiceRecord {
  const dataIndex = (seed + index) % vendors.length;
  const vendor = vendors[dataIndex];
  const customer = customers[dataIndex];
  const items = lineItems[dataIndex];
  const invoiceNo = `INV-${2026}-${String(1000 + seed + index).padStart(4, '0')}`;
  const dates = dateStrings(seed + index);
  const missing = { dueDate: (seed + index) % 5 === 1, payerEmail: (seed + index) % 4 === 2 };
  return {
    width: style === 'receipt' ? 720 : 1000,
    height: style === 'receipt' ? 1100 : 1414,
    vendor, customer, items, invoiceNo, dates, taxRate: vendor.tax, style, missing,
    payerEmail: `ap+${(seed + index) % 80}@${customer.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
  };
}

async function main(): Promise<void> {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`Error: ${error instanceof Error ? error.message : String(error)}\nRun with --help for usage.`); process.exit(2); }
  await mkdir(options.out, { recursive: true });
  const source = options.manifest ? JSON.parse(await readFile(options.manifest, 'utf8')) : null;
  if (source && (!Array.isArray(source.scenarios) || source.scenarios.length === 0)) throw new Error('Manifest must contain invoice scenarios');
  const count = source ? source.scenarios.length : options.count;
  const created = [];
  for (let i = 0; i < count; i++) {
    const style: Style = options.style === 'all' ? styles[(options.seed + i) % styles.length] : options.style;
    const record = makeRecord(i, options.seed, style);
    const scenario = source?.scenarios[i];
    if (scenario) {
      if (!scenario.invoiceNumber || !Number.isFinite(scenario.amount) || scenario.amount <= 0 || !/^[A-Z]{3}$/.test(scenario.currency) || !/^\d{4}-\d{2}-\d{2}$/.test(scenario.invoiceDate)) throw new Error(`Invalid invoice scenario at index ${i}`);
      record.invoiceNo = scenario.invoiceNumber;
      record.vendor = { ...record.vendor, currency: scenario.currency, symbol: `${scenario.currency} `, tax: 0 };
      record.taxRate = 0;
      record.items = [{ description: 'Professional services', detail: 'Sandbox test invoice', qty: 1, unit: scenario.amount }];
      const due = new Date(`${scenario.invoiceDate}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + 14);
      record.dates = { invoiceDate: scenario.invoiceDate, isoDate: scenario.invoiceDate, dueDate: due.toISOString().slice(0, 10) };
      record.payerEmail = scenario.payerEmail ?? '';
      record.missing = { payerEmail: !scenario.payerEmail, dueDate: scenario.case === 'missing-email-and-due-date' };
    }
    const canvas = createCanvas(record.width, record.height);
    const ctx = canvas.getContext('2d');
    const background = style === 'classic' ? '#fffefa' : style === 'receipt' ? '#fff' : '#fff';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, record.width, record.height);
    if (style === 'receipt') drawReceipt(ctx, record, palette[style], record.missing);
    else drawStandard(ctx, style, record, palette[style], record.missing);
    const ext = options.format === 'jpeg' ? 'jpg' : 'png';
    const fileName = `${record.invoiceNo.toLowerCase()}-${scenario ? `${scenario.case}-` : ''}${style}.${ext}`;
    const filePath = path.join(options.out, fileName);
    const bytes = options.format === 'jpeg' ? canvas.toBuffer('image/jpeg', 92) : canvas.toBuffer('image/png');
    await writeFile(filePath, bytes);
    const subtotal = record.items.reduce((sum, item) => sum + item.qty * item.unit, 0);
    created.push({ fileName, style, bytes: bytes.length, case: scenario?.case ?? 'synthetic',
      expected: scenario?.expected ?? null, reason: scenario?.reason ?? null,
      invoice: { invoice_number: record.invoiceNo, vendor_name: record.vendor.name,
        amount: Number((subtotal + Math.round(subtotal * record.taxRate) / 100).toFixed(2)),
        currency: record.vendor.currency, invoice_date: record.dates.isoDate,
        payer_email: record.missing.payerEmail ? null : record.payerEmail,
        due_date: record.missing.dueDate ? null : record.dates.dueDate },
      paymentIds: source?.transactions?.filter((t: any) => t.raw?.order?.invoice_id === record.invoiceNo || t.raw?.order?.custom_id === `invoice-sync:${record.invoiceNo}` || scenario?.payments.some((p: any) => p.order?.id === t.referenceId)).map((t: any) => t.transactionId) ?? [] });
  }
  await writeFile(path.join(options.out, 'manifest.json'), JSON.stringify({ source: options.manifest ?? null, invoices: created }, null, 2) + '\n');
  console.log(`Generated ${created.length} invoice image${created.length === 1 ? '' : 's'} in ${options.out}`);
  for (const file of created) console.log(`  ${file.fileName}  (${file.style}, ${(file.bytes / 1024).toFixed(0)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
