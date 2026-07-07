# coinpaybot — CoinPayPortal for GitHub

Create [CoinPayPortal](https://coinpayportal.com) crypto invoices and payment links directly from GitHub issue and pull-request comments.

A maintainer comments:

```
/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"
```

…and the bot creates a CoinPayPortal payment and replies with a payable link.

This repository is the **GitHub Action MVP** (PRD Phase 1). It runs on `issue_comment.created`, needs no hosted service, and can be dropped into any repo.

## Quick start

1. In CoinPayPortal, create an API key (`cp_live_...`) and note your **business id**. Make sure the business has a **receiving wallet configured for the crypto you invoice in** (e.g. `usdc_pol`) — without one, payment creation fails (see [Limitations](#limitations)).
2. Add repository secrets `COINPAY_API_KEY` and `COINPAY_BUSINESS_ID`.
3. Copy [`examples/coinpay-invoice.yml`](examples/coinpay-invoice.yml) to `.github/workflows/coinpay.yml`.

## Commands

| Command | Who | Description |
| --- | --- | --- |
| `/coinpay invoice <amount> USD --crypto <code> --for "<desc>"` | Maintainer (direct) / contributor (request) | Create or request a payment. |
| `/coinpay approve` | Maintainer | Approve the pending request in this thread. |
| `/coinpay cancel` | Maintainer | Cancel the pending request in this thread. |
| `/coinpay status` | Anyone | Payment status (pull-only in Action mode). |
| `/coinpay help` | Anyone | Show help. |

`<code>` is a CoinPayPortal crypto code: `usdc_pol`, `usdc_sol`, `usdc_base`, `usdt_pol`, `btc`, `eth`, `sol`, … Amounts are **USD-denominated**.

Direct-create vs. request is decided by the commenter's `author_association`: `OWNER`/`MEMBER`/`COLLABORATOR` create directly; everyone else creates a pending request a maintainer approves. Tune with [`.github/coinpay.yml`](examples/coinpay.yml).

## How it works

`issue_comment` → parse `/coinpay` → permission gate → CoinPayPortal `POST /api/payments/create` → reply with `…/pay/{payment_id}` and a `coinpay:*` label. The request→approve flow is **stateless**: the pending terms are embedded as a hidden marker in the bot's comment, and idempotency is enforced by a per-comment `handled` marker, so no database is required.

## Limitations (Action MVP)

- **A receiving wallet (or `--wallet <address>`) is required.** Crypto payment creation returns an error otherwise.
- **No live webhook status sync.** A GitHub Action is ephemeral and cannot receive CoinPayPortal webhooks, so `coinpay:paid` / `coinpay:expired` labels and paid-status comments land with the hosted GitHub App (Phase 2), not here.
- Card / `both` payment methods require Stripe Connect on the CoinPayPortal business.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test      # unit + contract + e2e (vitest)
pnpm run build     # bundle dist/index.js (committed; GitHub runs it)
```

Contract tests (`test/coinpay.contract.test.ts`) pin the adapter to the CoinPayPortal API shapes verified against its `master` source, including the `t=<ts>,v1=<hmac>` webhook signature. If CoinPayPortal changes its contract, these fail loudly.

## License

MIT
