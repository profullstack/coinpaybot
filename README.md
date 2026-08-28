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
| `/coinpay create $10 USD --wallet <address>` | Maintainer on a PR | Create an idempotent payment from the PR and up to five linked closing issues. Add `--dry-run` to preview without creating anything. |
| `/coinpay invoice <amount> USD --crypto <code> --for "<desc>"` | Maintainer (direct) / contributor (request) | Create or request a payment. |
| `/coinpay approve` | Maintainer | Approve the pending request in this thread. |
| `/coinpay cancel` | Maintainer | Cancel the pending request in this thread. |
| `/coinpay status` | Anyone | Payment status (pull-only in Action mode). |
| `/coinpay help` | Anyone | Show help. |

`<code>` is a CoinPayPortal crypto code: `usdc_pol`, `usdc_sol`, `usdc_base`, `usdt_pol`, `btc`, `eth`, `sol`, … Amounts are **USD-denominated decimal values** with up to two fractional digits and up to nine digits before the decimal point. The PR-backed `create` command requires an explicit maintainer-supplied wallet and derives its description and canonical links from GitHub rather than accepting free-form invoice text.

Direct-create vs. request is decided by the commenter's `author_association`: `OWNER`/`MEMBER`/`COLLABORATOR` create directly; everyone else creates a pending request a maintainer approves. Tune with [`.github/coinpay.yml`](examples/coinpay.yml).

## How it works

`issue_comment` → parse `/coinpay` → permission gate → CoinPayPortal `POST /api/payments/create` → reply with `…/pay/{payment_id}` and a `coinpay:*` label. The request→approve flow is **stateless**: pending terms use an encoded hidden marker in an Action-authored comment. Marker state is accepted only from the exact `trusted-comment-author` login (default: `github-actions[bot]`), and hidden-comment syntax copied from user text, PR titles, or linked issue titles is neutralized before rendering. PR-backed payments also use a deterministic payment identity in both the GitHub reply and CoinPayPortal's idempotency contract, so retrying the same terms cannot create a second payment.

If `github-token` is a PAT or another token that posts as a different login, set `trusted-comment-author` to that exact GitHub login. Never set it to another integration's bot account. Also audit other workflows that post comments as the same login: they must not copy untrusted issue, PR, branch, or file text into HTML comments, because that shared identity is the trust boundary for CoinPay's stateless markers.

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
