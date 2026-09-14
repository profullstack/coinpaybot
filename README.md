# coinpaybot — CoinPayPortal for GitHub

Track merged-PR contribution rewards with [CoinPayPortal](https://coinpayportal.com), pay whole cents manually through checkout, or use the separate invoice commands from GitHub comments.

With repository enrollment and explicit opt-in, each merged PR earns **$0.001 USD**: ten PRs make one cent. The portal prevents duplicate accrual; the bot never pays automatically. See [merged PR rewards and setup](docs/pr-commands.md).

A maintainer comments:

```
/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"
```

…and the bot creates a CoinPayPortal payment and replies with a payable link.

This repository is a GitHub Action. Its shared workflow handles merged PRs and maintainer commands; CoinPayPortal stores contribution balances and payment records. Legacy invoice commands also work on `issue_comment.created`.

## Quick start

For merged-PR contribution rewards and manual payments across repositories, use the
[shared PR workflow](docs/pr-commands.md). A small pinned caller adds current
repository permission checks and setup checks without copying that logic into
each repository. The direct Action setup below also supports general issue
commands and contributor request flows.

1. In CoinPayPortal, create an API key (`cp_live_...`) and note your **business id**. Make sure the business has a **receiving wallet configured for the crypto you invoice in** (e.g. `usdc_pol`) — without one, payment creation fails (see [Limitations](#limitations)).
2. Add repository secrets `COINPAY_API_KEY` and `COINPAY_BUSINESS_ID`.
3. Copy [`examples/coinpay-invoice.yml`](examples/coinpay-invoice.yml) to `.github/workflows/coinpay.yml`.

## Commands

| Command | Who | Description |
| --- | --- | --- |
| `/coinpay balance` | Current repository maintainer on a PR | Show this contributor's repository reward balance and payable whole cents. Requires contribution opt-in. |
| `/coinpay settle --wallet <address> --blockchain USDC_POL` | Current repository maintainer on a PR | Reserve available whole cents for a manually paid contributor checkout. The wallet and chain must be independently verified. |
| `/coinpay create @payer <amount> "<desc>"` | Anyone (opt-in, disabled by default) | Create **and publish** a CoinPayPortal invoice from the repository's configured business and reply with a live payment link. Add `--dry-run` to preview without creating anything. See [GitHub-published invoices](#github-published-invoices-coinpay-create-payer). |
| `/coinpay create $10 USD --wallet <address>` | Maintainer on a PR | Create an idempotent payment from the PR and up to five linked closing issues. Add `--dry-run` to preview without creating anything. |
| `/coinpay invoice <amount> USD --crypto <code> --for "<desc>"` | Maintainer (direct) / contributor (request) | Create or request a payment. |
| `/coinpay approve` | Maintainer | Approve the pending request in this thread. |
| `/coinpay cancel` | Maintainer | Cancel the pending request in this thread. |
| `/coinpay status` | Anyone | Payment status (pull-only in Action mode). |
| `/coinpay help` | Anyone | Show help. |

The first argument after `create` selects the flow: `@payer` runs the invoice flow below, while a numeric amount keeps the legacy PR-backed payment flow exactly as before (including its maintainer gate and `--wallet` requirement). Neither flow falls back to the other.

`<code>` is a CoinPayPortal crypto code: `usdc_pol`, `usdc_sol`, `usdc_base`, `usdt_pol`, `btc`, `eth`, `sol`, … Amounts are **USD-denominated decimal values** with up to two fractional digits and up to nine digits before the decimal point. The PR-backed `create` command requires an explicit maintainer-supplied wallet and derives its description and canonical links from GitHub rather than accepting free-form invoice text.

Direct-create vs. request is decided by the commenter's `author_association`: `OWNER`/`MEMBER`/`COLLABORATOR` create directly; everyone else creates a pending request a maintainer approves. Tune with [`.github/coinpay.yml`](examples/coinpay.yml). The `minRoleToCreateInvoice` gate applies to the legacy payment flow only — the `@payer` invoice flow has its own safeguards below.

## GitHub-published invoices (`/coinpay create @payer …`)

```
/coinpay create @octocat 25 "Fix the settlement race"
/coinpay create @octocat $25 USD "Fix the settlement race" --dry-run
```

Creates a **draft invoice** on the repository's configured CoinPayPortal business via the idempotent `POST /api/invoices` contract, **publishes** it (live payment details, **no email is sent**), and replies with the payer mention, invoice number, USD amount, description, the platform fee taken from the API response, and the live `…/now/{invoice}` payment link. Payment happens inside CoinPayPortal so the platform fee applies; the bot never moves funds, never marks anything paid, and never calls send/paid/delete APIs.

**Honest limitation — who issues, who pays.** The invoice issuer is always the **repository's configured CoinPayPortal business** (`COINPAY_BUSINESS_ID` + `COINPAY_API_KEY` from repository secrets). It is *not* the commenting user's personal CoinPay account: no GitHub-to-CoinPay account mapping exists yet. Likewise `@payer` is only a GitHub mention used for notification and audit — it is not a verified CoinPay client, and no client record is created. Every bot reply states this. Personal account linking is a later, separate milestone.

**Who may run it.** Once enabled, any human commenter — deliberately no role allowlist. Bot-authored and edited comments are ignored. The mandatory safeguards are non-identity ones:

- **Feature flag, default off** (`githubInvoices.enabled`). Roll out in this order: **1)** deploy the CoinPayPortal idempotent invoice creation API **and its database migration**, **2)** verify a test call succeeds, **3)** only then set `githubInvoices.enabled: true`. Until then the command replies with a safe explanation (and the API would answer 503 anyway). The global `enabled: false` kill switch also covers this command.
- **Per-invoice cap** `githubInvoices.maxAmountUsd` (default 1000).
- **Per-repository hourly cap** `githubInvoices.repositoryHourlyCap` (default 20, API range 1–1000), enforced **atomically by CoinPayPortal** per business/repository, so parallel workflow runs cannot overshoot it. Idempotent replays don't consume the cap.
- **One invoice per source comment.** The `Idempotency-Key` uses the immutable repository ID + comment ID, so redeliveries, reruns, and process restarts return the *original* invoice instead of a new one; the same key with different terms is rejected (409). A repository rename can change the source notes and cause a 409, but cannot create another invoice under a new key. A deleted invoice is never recreated (410) and a closed (e.g. already paid) invoice is reported but never reopened or republished.
- **Strict parsing**: one valid GitHub `@login`, a positive USD amount with at most two decimals, a quoted plain-text description (≤200 chars, control characters stripped), optional literal `USD`, and `--dry-run` as the only flag. No wallet, client, email, or any other flag can be injected; the business's configured receiving wallet is always the payee.
- **Audit source data**: the immutable numeric GitHub actor id, actor login, payer login, repository, thread and comment id are recorded on the invoice (`source_reference`), and the notes carry the canonical thread URL.

If draft creation succeeds but publish fails (including a `409` while payment details are still being generated), the bot replies with a safe retry message and **posts no payment link**. A maintainer must **re-run the same GitHub Actions run**, preserving its original comment ID; posting a new command comment would request a separate invoice. Each invoice request has a 30-second network timeout; a lost response may mean creation already succeeded, so the same-run retry is important. Replies never contain raw API errors, keys, or wallet addresses. Duplicate *GitHub comments* are best-effort deduplicated (hidden `coinpay:handled` markers plus a post-publish re-check) — GitHub offers no atomic lock, so the hard uniqueness guarantee is on the invoice itself, not the reply.

`--dry-run` previews the exact invoice (amount, description, crypto, idempotency key) without calling CoinPayPortal, changing labels, or notifying the payer (the mention is rendered inert).

### Deployment checks before enabling

- Set the Action's `coinpay-base-url` to the same public origin as the portal's `NEXT_PUBLIC_APP_URL` (ignoring a trailing slash). The bot rejects unexpected payment-link origins instead of posting them.
- Explicitly accept that any human commenter can create invoices under the configured business and notify a payer. No funds move automatically, but open usage can generate unwanted invoices and mentions.
- The invoice publish path does not use the legacy payment-creation route's monthly quota check. The hourly cap is a repository integration safeguard, not a subscription entitlement or a substitute for platform-wide abuse controls. Keep the feature disabled until the business owner accepts that rollout boundary.
- A rejected request needs its terms/configuration checked before retrying. Do not repeatedly re-run a permanent validation failure or post replacement commands without checking whether an invoice already exists.

## How it works

`issue_comment` → parse `/coinpay` → permission gate → CoinPayPortal `POST /api/payments/create` → reply with `…/pay/{payment_id}` and a `coinpay:*` label. The request→approve flow is **stateless**: pending terms use an encoded hidden marker in an Action-authored comment. Marker state is accepted only from the exact `trusted-comment-author` login (default: `github-actions[bot]`), and hidden-comment syntax copied from user text, PR titles, or linked issue titles is neutralized before rendering. PR-backed payments also use a deterministic payment identity in both the GitHub reply and CoinPayPortal's idempotency contract, so retrying the same terms cannot create a second payment.

If `github-token` is a PAT or another token that posts as a different login, set `trusted-comment-author` to that exact GitHub login. Never set it to another integration's bot account. Also audit other workflows that post comments as the same login: they must not copy untrusted issue, PR, branch, or file text into HTML comments, because that shared identity is the trust boundary for CoinPay's stateless markers.

## Limitations (Action MVP)

- **A receiving wallet (or `--wallet <address>`) is required.** Crypto payment creation returns an error otherwise. The `@payer` invoice flow uses only the business's configured wallet and fails safely when none exists.
- **No live webhook status sync.** A GitHub Action is ephemeral and cannot receive CoinPayPortal webhooks, so `coinpay:paid` / `coinpay:expired` labels and paid-status comments land with the hosted GitHub App (Phase 2), not here. In particular, `/coinpay status` never reports an invoice as paid just because it was created.
- **Optional PDF snapshot link, default off** (`githubInvoices.pdfEnabled`). Deploy and verify CoinPayPortal's public `GET /api/invoices/{uuid}/pdf` endpoint first, then set this boolean to `true`. Published replies retain the checkout link and add a PDF download link, not a GitHub attachment. No PDF is fetched, stored or emailed by the bot; an unavailable PDF never triggers invoice creation again. Use the live invoice for current status and as the fallback. Dry runs, legacy commands and contribution rewards are unchanged. PDFs are public snapshots, not receipts, and intentionally omit notes, client details and wallet addresses.
- **No personal CoinPay accounts.** GitHub-published invoices are issued by the repository's configured business; commenter/payer account linking, client records, status webhooks, refunds/cancellations, and multi-business routing are out of scope for this slice.
- Card / `both` payment methods require Stripe Connect on the CoinPayPortal business.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test      # unit + contract + e2e (vitest)
pnpm run build     # bundle dist/index.js (committed; GitHub runs it)
pnpm run test:workflow # execute actual reusable-workflow guards with mocks
pnpm run test:bundle   # execute committed bundle with all real network denied
```

Contract tests (`test/coinpay.contract.test.ts`) pin the adapter to the CoinPayPortal API shapes verified against its `master` source, including the `t=<ts>,v1=<hmac>` webhook signature. If CoinPayPortal changes its contract, these fail loudly.

## License

MIT
