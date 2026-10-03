#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Generate PayPal sandbox payments and matching invoice images together.

Usage: npm run generate:paypal-transactions-and-invoices -- [options]

  --out <directory>       New run directory (default: test-runs/<timestamp>-<id>)
  --resume <directory>    Continue a saved run without creating another set of payments
  --format <png|jpeg>     Invoice image format (default: png)
  --style <name|all>      modern, classic, receipt, minimal, ledger, all (default: all)
  --seed <integer>        Invoice layout offset (default: 42)
  --dry-run              Show the workflow without creating payments or files
  -h, --help             Show this help

Each run contains 17 invoice cases, 14 completed captures, one declined capture,
and one unapproved order. Upload invoices/ to your selected Drive folder and Scan.
Credentials come from the project's .env and config.yaml. Sandbox only.
Saves transaction and invoice files; never imports into the app's payment cache.`;

type Options = { out?: string; resume?: string; format?: string; style?: string; seed?: string; dryRun: boolean };
type State = {
  version: 1; directory: string; createdAt: string; accountKey: string;
  format: string; style: string; seed: string;
  stage: 'payments' | 'invoices' | 'complete';
};
type PaymentManifest = {
  run: string;
  scenarios: { case: string; expected: string; reason: string; invoiceNumber: string }[];
  transactions: { status: string; transactionId: string; amount: number; currency: string }[];
};

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };
  const values = new Map<string, keyof Options>([
    ['--out', 'out'], ['--resume', 'resume'],
    ['--format', 'format'], ['--style', 'style'], ['--seed', 'seed'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    const key = values.get(argv[i]);
    if (!key) throw new Error(`Unknown option: ${argv[i]}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${argv[i - 1]}`);
    Object.assign(options, { [key]: value });
  }
  if (options.out && options.resume) throw new Error('Use either --out or --resume');
  if (options.format && !['png', 'jpeg'].includes(options.format)) throw new Error('--format must be png or jpeg');
  if (options.style && !['all', 'modern', 'classic', 'receipt', 'minimal', 'ledger'].includes(options.style)) throw new Error('Unknown --style');
  if (options.seed && (!/^\d+$/.test(options.seed) || !Number.isSafeInteger(Number(options.seed)))) throw new Error('--seed must be a non-negative safe integer');
  return options;
}

async function main() {
  if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg))) { console.log(help); return; }
  const options = parseArgs(process.argv.slice(2));
  // Child scripts execute inside the isolated run directory. Load credentials
  // from the project explicitly and give each child an absolute config path.
  dotenv.config({ path: path.join(projectRoot, '.env') });
  const configPath = path.resolve(process.env.CONFIG_PATH || path.join(projectRoot, 'config.yaml'));
  process.env.CONFIG_PATH = configPath;
  const { config } = await import('../src/config.js');
  if (config.paypal.mode !== 'sandbox' || config.paypal.baseUrl.replace(/\/$/, '') !== 'https://api-m.sandbox.paypal.com') throw new Error('This workflow requires PayPal sandbox mode and sandbox API URL');
  if (!config.paypal.clientId || !config.paypal.clientSecret) throw new Error('Missing PayPal credentials in .env');
  const { createHash } = await import('node:crypto');
  const accountKey = createHash('sha256').update(`${config.paypal.baseUrl}:${config.paypal.clientId}`).digest('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.resolve(options.resume || options.out || path.join(projectRoot, 'test-runs', `${stamp}-${randomUUID().slice(0, 8)}`));
  const stateFile = path.join(directory, 'run.json');
  const manifestFile = path.join(directory, 'sandbox-test-data', 'manifest.json');
  let state: State;
  if (options.resume) {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    // Older workflow states may contain a cache-import stage. Resume them as
    // completed invoice generation, with no database access or cache writes.
    const { userId: _oldUserId, ...generationState } = saved;
    state = { ...generationState, stage: saved.stage === 'import' ? 'complete' : saved.stage };
    if (state.version !== 1 || state.accountKey !== accountKey) throw new Error('Saved run is invalid or belongs to another sandbox account');
    if (!['payments', 'invoices', 'complete'].includes(state.stage)) throw new Error('Invalid saved workflow stage');
    for (const key of ['format', 'style', 'seed'] as const) {
      if (options[key] !== undefined && state[key] !== undefined && options[key] !== state[key]) throw new Error(`Resume must retain the original ${key}`);
    }
    state.directory = directory;
  } else {
    state = { version: 1, directory, createdAt: new Date().toISOString(), accountKey,
      format: options.format ?? 'png', style: options.style ?? 'all', seed: options.seed ?? '42',
      stage: 'payments' };
  }

  console.log(`Run directory: ${directory}`);
  if (options.dryRun) {
    console.log(`Starting stage: ${state.stage}\nCreate/resume sandbox payments → render 17 invoices (${state.format}, ${state.style}).`);
    return;
  }
  if (!options.resume) {
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory); // Existing runs must be resumed explicitly.
  }
  const lockFile = path.join(directory, '.workflow.lock');
  const lock = await open(lockFile, 'wx').catch(() => { throw new Error(`This run is locked: ${lockFile}. If an earlier process was killed, remove the lock after confirming it has stopped.`); });
  const saveState = async () => {
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + '\n');
    await rename(`${stateFile}.tmp`, stateFile);
  };
  const runScript = (script: string, args: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), path.join(projectRoot, 'scripts', script), ...args], {
      cwd: directory, env: { ...process.env, CONFIG_PATH: configPath }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script} failed (${signal ?? `exit ${code}`})`)));
  });
  try {
    await lock.writeFile(`pid=${process.pid}\n`);
    await saveState();
    if (state.stage === 'payments') {
      const existing = await readFile(manifestFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      await runScript('seed-paypal.ts', [existing ? '--resume' : '--new-run']);
      state.stage = 'invoices'; await saveState();
    }
    if (state.stage === 'invoices') {
      await runScript('generate-invoices-from-paypal-transactions.ts', ['--manifest', manifestFile, '--out', path.join(directory, 'invoices'), '--format', state.format, '--style', state.style, '--seed', state.seed]);
      state.stage = 'complete'; await saveState();
    }
    const payments: PaymentManifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const invoices = JSON.parse(await readFile(path.join(directory, 'invoices', 'manifest.json'), 'utf8'));
    const summary = {
      run: payments.run, completedAt: new Date().toISOString(),
      paymentStatuses: payments.transactions.reduce<Record<string, number>>((counts, txn) => { counts[txn.status] = (counts[txn.status] ?? 0) + 1; return counts; }, {}),
      expectedInvoiceStatuses: payments.scenarios.reduce<Record<string, number>>((counts, scenario) => { counts[scenario.expected] = (counts[scenario.expected] ?? 0) + 1; return counts; }, {}),
      cases: invoices.invoices,
    };
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`\nReady: ${invoices.invoices.length} invoices in ${path.join(directory, 'invoices')}`);
    console.log(`Captures: ${JSON.stringify(summary.paymentStatuses)}\nExpected invoice outcomes: ${JSON.stringify(summary.expectedInvoiceStatuses)}`);
    console.log(`Details: ${path.join(directory, 'summary.json')}\nUpload the invoice images to your selected Drive folder, then run Scan.`);
  } catch (error) {
    console.error(`Resume this run with:\n  npm run generate:paypal-transactions-and-invoices -- --resume ${JSON.stringify(directory)}`);
    throw error;
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

main().catch(error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
