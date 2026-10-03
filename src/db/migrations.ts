export const MIGRATION_001 = `
-- 001_init: idempotent base schema for Invoice Sync.
-- Safe to run on every app start. No triggers used; updated_at handled in code.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT,
  name TEXT,
  email_verified_at TIMESTAMPTZ,
  google_sub TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_verification_tokens_hash_idx ON email_verification_tokens (token_hash);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_idx ON password_reset_tokens (token_hash);

CREATE TABLE IF NOT EXISTS email_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_jobs_status_next_idx ON email_jobs (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS google_drive_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  folder_id TEXT,
  folder_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS google_drive_connections_user_idx ON google_drive_connections (user_id);

CREATE TABLE IF NOT EXISTS paypal_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT,
  client_secret TEXT,
  mode TEXT NOT NULL DEFAULT 'sandbox',
  base_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS paypal_connections_user_idx ON paypal_connections (user_id);

CREATE TABLE IF NOT EXISTS scan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  drive_folder_id TEXT,
  files_seen INT NOT NULL DEFAULT 0,
  files_new INT NOT NULL DEFAULT 0,
  files_rescanned INT NOT NULL DEFAULT 0,
  transactions_synced INT NOT NULL DEFAULT 0,
  matches_created INT NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scan_runs_user_created_idx ON scan_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  drive_file_name TEXT NOT NULL,
  mime_type TEXT,
  drive_modified_time TIMESTAMPTZ,
  drive_web_view_link TEXT,
  raw_text TEXT,
  extracted_json JSONB,
  invoice_number TEXT,
  vendor_name TEXT,
  amount NUMERIC(14,2),
  currency TEXT,
  invoice_date DATE,
  due_date DATE,
  payer_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS invoices_user_status_idx ON invoices (user_id, status);
CREATE INDEX IF NOT EXISTS invoices_user_amount_idx ON invoices (user_id, amount);
CREATE INDEX IF NOT EXISTS invoices_user_date_idx ON invoices (user_id, invoice_date);
CREATE INDEX IF NOT EXISTS invoices_user_number_idx ON invoices (user_id, invoice_number);

CREATE TABLE IF NOT EXISTS paypal_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paypal_transaction_id TEXT NOT NULL,
  paypal_reference_id TEXT,
  event_code TEXT,
  status TEXT,
  amount NUMERIC(14,2),
  currency TEXT,
  fee NUMERIC(14,2),
  payer_email TEXT,
  payer_name TEXT,
  transaction_initiated_at TIMESTAMPTZ,
  transaction_updated_at TIMESTAMPTZ,
  raw_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, paypal_transaction_id, transaction_initiated_at)
);
CREATE INDEX IF NOT EXISTS paypal_transactions_user_amount_idx ON paypal_transactions (user_id, amount);
CREATE INDEX IF NOT EXISTS paypal_transactions_user_date_idx ON paypal_transactions (user_id, transaction_initiated_at);
CREATE INDEX IF NOT EXISTS paypal_transactions_user_currency_idx ON paypal_transactions (user_id, currency);

CREATE TABLE IF NOT EXISTS invoice_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  paypal_transaction_id UUID REFERENCES paypal_transactions(id) ON DELETE SET NULL,
  score INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unmatched',
  reasons JSONB NOT NULL DEFAULT '[]',
  scan_run_id UUID REFERENCES scan_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, paypal_transaction_id)
);
CREATE INDEX IF NOT EXISTS invoice_matches_user_status_idx ON invoice_matches (user_id, status);
CREATE INDEX IF NOT EXISTS invoice_matches_invoice_idx ON invoice_matches (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_matches_txn_idx ON invoice_matches (paypal_transaction_id);

CREATE TABLE IF NOT EXISTS sync_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL DEFAULT 'none',
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS sync_configs_next_run_idx ON sync_configs (next_run_at) WHERE cadence <> 'none';
`;

export const MIGRATION_002 = `
-- 002_clerk: link local users to Clerk users. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_clerk_id_idx ON users (clerk_user_id) WHERE clerk_user_id IS NOT NULL;
`;

export const MIGRATION_003 = `
-- 003_paypal_login: link local users to PayPal (Login with PayPal). Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS paypal_payer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_paypal_payer_id_idx ON users (paypal_payer_id) WHERE paypal_payer_id IS NOT NULL;
`;

export const MIGRATION_004 = `
ALTER TABLE google_drive_connections ADD COLUMN IF NOT EXISTS folders JSONB NOT NULL DEFAULT '[]';
UPDATE google_drive_connections SET folders=jsonb_build_array(jsonb_build_object('id',folder_id,'name',COALESCE(folder_name,folder_id)))
WHERE folder_id IS NOT NULL AND folders='[]'::jsonb;
CREATE TABLE IF NOT EXISTS drive_oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
`;

export const MIGRATION_005 = `
-- 005_scan_progress: live progress + cooperative cancel for scan_runs. Idempotent.
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS files_total INT NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS files_processed INT NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS current_stage TEXT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS current_file TEXT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE scan_runs SET files_total = files_seen WHERE files_total = 0;
`;

export const MIGRATION_006 = `
-- Replace legacy scoring results; invoice files and cached transactions remain available.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='invoice_matches' AND column_name='decision') THEN
    DELETE FROM invoice_matches;
  END IF;
END $$;
ALTER TABLE invoice_matches ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE invoice_matches ADD COLUMN IF NOT EXISTS percentage INT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_matches_one_per_invoice_idx ON invoice_matches (invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_matches_one_payment_idx ON invoice_matches (user_id,paypal_transaction_id) WHERE status='matched' AND paypal_transaction_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS paypal_cache_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_cache_days (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL,
  day DATE NOT NULL,
  covered_until TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,account_key,day)
);
`;

export const MIGRATION_007 = `
-- 007_razorpay: Razorpay integration. Idempotent.
CREATE TABLE IF NOT EXISTS razorpay_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT,
  key_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS razorpay_connections_user_idx ON razorpay_connections (user_id);

CREATE TABLE IF NOT EXISTS razorpay_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  razorpay_payment_id TEXT NOT NULL,
  razorpay_order_id TEXT,
  razorpay_invoice_id TEXT,
  method TEXT,
  status TEXT,
  amount NUMERIC(14,2),
  currency TEXT,
  payer_email TEXT,
  payer_contact TEXT,
  description TEXT,
  transaction_initiated_at TIMESTAMPTZ,
  raw_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, razorpay_payment_id, transaction_initiated_at)
);
CREATE INDEX IF NOT EXISTS razorpay_payments_user_amount_idx ON razorpay_payments (user_id, amount);
CREATE INDEX IF NOT EXISTS razorpay_payments_user_date_idx ON razorpay_payments (user_id, transaction_initiated_at);
CREATE INDEX IF NOT EXISTS razorpay_payments_user_currency_idx ON razorpay_payments (user_id, currency);

-- Invoice matches can now point at either a PayPal transaction or a Razorpay payment.
ALTER TABLE invoice_matches ADD COLUMN IF NOT EXISTS razorpay_payment_id UUID REFERENCES razorpay_payments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_matches_one_razorpay_idx ON invoice_matches (user_id, razorpay_payment_id) WHERE status='matched' AND razorpay_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS razorpay_cache_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS razorpay_cache_days (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL,
  day DATE NOT NULL,
  covered_until TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,account_key,day)
);
`;

export const MIGRATION_008 = `
CREATE TABLE IF NOT EXISTS paypal_oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS paypal_oauth_states_expiry_idx ON paypal_oauth_states (expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry_idx ON auth_rate_limits (expires_at);
ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS claim_token UUID;
CREATE INDEX IF NOT EXISTS email_jobs_processing_idx ON email_jobs (updated_at) WHERE status='processing';
`;

export const MIGRATION_009 = `
-- 009_demo_chat_paynow_webhooks: Zapier-style scan webhooks + Pay Now order tracking. Idempotent.
CREATE TABLE IF NOT EXISTS webhook_configs (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_status TEXT,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pay_now_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'order',
  order_id TEXT,
  batch_id TEXT,
  approval_url TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  amount NUMERIC(14,2),
  currency TEXT,
  receiver_email TEXT,
  raw_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pay_now_orders_user_idx ON pay_now_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pay_now_orders_invoice_idx ON pay_now_orders (invoice_id);
-- Demo invoices may reference synthetic drive files (drive_file_id LIKE 'demo-%');
-- no schema change needed, but ensure invoices accept long synthetic ids (TEXT already does).
`;
