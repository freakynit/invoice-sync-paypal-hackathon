#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Generate invoice images corresponding to previously generated PayPal transactions.

Usage: npm run generate:invoices-from-paypal-transactions -- [options]

  --manifest <file>      Saved transaction manifest (default: sandbox-test-data/manifest.json)
  --run <directory>      Use a combined workflow run's sandbox-test-data/manifest.json
  --out <directory>      Output directory (default: a new folder in sample-invoices/paypal-matching)
  --format <png|jpeg>    Image format (default: png)
  --style <name|all>     modern, classic, receipt, minimal, ledger, all (default: all)
  --seed <integer>       Invoice layout offset (default: 42)
  -h, --help            Show this help

Renders every saved scenario with its original invoice number, amount, currency,
date and expected result: matched, needs_review or unmatched. Changing appearance
does not change matching fields. Creates files only; no API or database access.
Upload the generated images to your selected Drive folder when you want to test.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.some(arg => ['--help', '-h'].includes(arg))) { console.log(help); return; }
  const options: Record<string, string> = { format: 'png', style: 'all', seed: '42' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--manifest', '--run', '--out', '--format', '--style', '--seed'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${arg}`);
    options[arg.slice(2)] = value;
  }
  if (options.manifest && options.run) throw new Error('Use either --manifest or --run');
  if (!['png', 'jpeg'].includes(options.format)) throw new Error('--format must be png or jpeg');
  if (!['all', 'modern', 'classic', 'receipt', 'minimal', 'ledger'].includes(options.style)) throw new Error('Unknown --style');
  if (!/^\d+$/.test(options.seed) || !Number.isSafeInteger(Number(options.seed))) throw new Error('--seed must be a non-negative safe integer');
  const manifestFile = options.run ? path.resolve(options.run, 'sandbox-test-data', 'manifest.json')
    : options.manifest ? path.resolve(options.manifest) : path.join(projectRoot, 'sandbox-test-data', 'manifest.json');
  const source = await readFile(manifestFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error(`No saved transaction manifest at ${manifestFile}. Generate transactions first, or supply --run or --manifest.`);
    throw error;
  });
  const manifest = JSON.parse(source);
  if (!Array.isArray(manifest.transactions) || !manifest.transactions.length || !Array.isArray(manifest.scenarios) || !manifest.scenarios.length) throw new Error('Expected a transaction manifest with captures and invoice scenarios');
  for (const scenario of manifest.scenarios) {
    if (!['matched', 'needs_review', 'unmatched'].includes(scenario.expected)
      || typeof scenario.case !== 'string' || !/^[a-z0-9-]+$/i.test(scenario.case)
      || typeof scenario.invoiceNumber !== 'string' || !/^[a-z0-9_-]+$/i.test(scenario.invoiceNumber)
      || !Array.isArray(scenario.payments)) throw new Error('Invalid saved invoice scenario');
  }
  const label = typeof manifest.run === 'string' ? manifest.run.replace(/[^a-z0-9_-]/gi, '-') : 'paypal';
  const directory = options.out ? path.resolve(options.out) : path.join(projectRoot, 'sample-invoices', 'paypal-matching', `${label}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  console.log(`Saved transactions: ${manifestFile}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), path.join(projectRoot, 'scripts', 'generate-invoices.ts'),
      '--manifest', manifestFile, '--out', directory, '--format', options.format, '--style', options.style, '--seed', options.seed], { cwd: projectRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Invoice rendering failed (${signal ?? `exit ${code}`})`)));
  });
  const expected = manifest.scenarios.reduce((counts: Record<string, number>, scenario: { expected: string }) => {
    counts[scenario.expected] = (counts[scenario.expected] ?? 0) + 1; return counts;
  }, {});
  console.log(`Expected invoice outcomes: ${JSON.stringify(expected)}\nInvoice fields, payment IDs and case explanations: ${path.join(directory, 'manifest.json')}`);
}

main().catch(error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
