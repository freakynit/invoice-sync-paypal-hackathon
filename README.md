# Invoice Sync

Choose one or more Google Drive folders of invoices → match every invoice against PayPal sandbox transactions → review a clean report. Built for the PayPal AI Hackathon (sandbox only — no live calls anywhere).

## Quick start

> Make sure copy `.env.example` to `.env` and it is populated. Create relevant postgre database beforehand.

```bash
npm install
npm run dev            # http://localhost:3000 — migrations run automatically
npm run build && npm start   # production
```

## Use of PayPal and AI in the project

1. Paypal sandbox for all testing and live demo.
2. vLLM (AI) for invoice parsing used for reconciliation with paypal transactions.
3. LLM (AI) for chatting across invoices, paypal transactions, and sync state.

## Generate sample invoices

Create synthetic PNG invoices for trying the image extractor. The default command writes eight invoices in varied layouts and currencies to `sample-invoices/`:

```bash
npm run generate:invoices
```

The generator accepts `--count` (1–100), `--seed`, `--out`, `--format png|jpeg`, and `--style modern|classic|receipt|minimal|ledger|all`. For example:

```bash
npm run generate:invoices -- --count 12 --seed 7 --format jpeg --style receipt --out /tmp/invoice-samples
```

Run `npm run generate:invoices -- --help` for the defaults and option details. The script is implemented in TypeScript and runs through the existing `tsx` dependency.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

