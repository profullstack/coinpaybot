# Merged PR rewards and manual payments

An enrolled repository can accrue **$0.001 USD per merged PR**, grouped by repository and contributor. The portal stores one integer mill for each qualifying merge. **Ten merged PRs earn one cent.** Replaying a workflow run does not earn a second reward. Only merges after the repository's enrollment cutoff qualify; installation does not backfill old PRs.

The bot records an amount owed. It does not automatically pay contributors. A maintainer explicitly supplies a verified wallet and chain to reserve whole cents, then pays through CoinPay checkout. Fractions below one cent remain in the ledger. The nominal reward is not a promise of the recipient's net amount: checkout shows the crypto quote and fees before payment.

## Install after the portal ledger is deployed

The merchant first enrolls the repository in CoinPayPortal and obtains a dedicated repository-bound key with contribution scopes. The portal must allowlist the exact reviewed reusable workflow ref and SHA in `GITHUB_CONTRIBUTIONS_WORKFLOW_PINS`. Unenrolled repositories, old generic keys and unapproved workflow pins fail closed.

Store the dedicated credentials in **new** consumer-repository secrets:

- `COINPAY_CONTRIBUTIONS_KEY`
- `COINPAY_CONTRIBUTIONS_BUSINESS_ID`

These preserve existing `COINPAY_API_KEY` and `COINPAY_BUSINESS_ID` secrets which another application or deployment may use. Copy [the caller](../examples/coinpay-pr-commands.yml) to `.github/workflows/coinpay.yml`, replace `REVIEWED_COMMIT_SHA` with the reviewed full 40-character workflow commit, and retain the mapping from the new secret names to the reusable workflow's existing `COINPAY_API_KEY` and `COINPAY_BUSINESS_ID` inputs.

The caller listens to `pull_request_target: closed` and `issue_comment: created`, with `id-token: write` and the documented GitHub read/comment permissions. The called job runs only the immutable reviewed Action bundle. It never checks out the PR head, executes PR code or evaluates comment text as code.

Put this exact opt-in on the default branch at `.github/coinpay.yml`:

```yaml
enabled: true
contributionRewards:
  enabled: true
  rateUsd: '0.001'
  payment: manual
githubInvoices:
  enabled: false
```

The quoted rate is intentional. Numeric `0.001`, different rates, extra reward settings and automatic payment modes are rejected. Omitting `contributionRewards` leaves accrual disabled. To turn it off, retain the same rate/payment settings and set its `enabled` to `false`, or set global `enabled` to `false`.

## Contributor commands

On a PR, a human with **current write, maintain or admin permission** can run:

```text
/coinpay balance
/coinpay settle --wallet <verified-contributor-address> --blockchain USDC_POL
```

Balance is for this PR's current author within this repository. It shows accrued, reserved, paid and available mills, whole cents payable and the remaining fraction. It reconciles any outstanding settlement against the existing payment record, without creating a checkout. Only verified forwarding with transaction proof counts as paid.

Before settlement, independently verify the author's receiving wallet and specific blockchain/token. Both command fields are required; the bot never copies a wallet from a profile, PR body or another comment. `USDC_POL` is an example uppercase CoinPay code. No amount is accepted: the portal atomically reserves the available whole cents. Below ten available mills, it creates no checkout.

Settlement replies say **reserved** or **awaiting payment** until the portal verifies payment. Open the returned `https://coinpayportal.com/pay/<id>` checkout, review its recipient, chain, quote and fee, and pay manually. Creating a checkout does not broadcast an outgoing wallet transaction or create a merchant receivable invoice.

A failed or incomplete checkout can leave its amount reserved. Re-run the **same Actions attempt**, retaining its immutable comment ID and unchanged wallet/chain. Posting a new comment creates a different idempotency key; changing terms while an unresolved reservation exists is rejected. A timeout, payment link or pending state is not payment proof. The portal's verified settlement record is the authority for status.

An expired checkout or a payment awaiting forwarding has no active payment link and keeps its reservation. Use `/coinpay balance` to reconcile progress; do not send a duplicate payment. An expired or failed forwarding record needs portal resolution before its funds can become available again.

To recover a failed accrual, re-run the **original merged-PR Actions run** after resolving its setup or service error. The current PR identity is checked again and a recorded merge is not counted twice. This recovers an existing event; it does not backfill historical PRs or bypass the enrollment cutoff. A merge without an original Actions run cannot be recovered by inventing a comment command.

## Trust and accounting

Both workflow and Action freshly read the PR through GitHub, verify its base repository, and require a closed, merged PR for accrual. Repository, owner, PR and contributor IDs are decimal strings; no caller-supplied rate or amount reaches the accrue endpoint. The portal enforces enrollment, cutoff and atomic event uniqueness.

Writes use the dedicated scoped key plus GitHub OIDC with audience `coinpayportal.com`. The portal checks GitHub's issuer, repository binding and approved `job_workflow_ref` / `job_workflow_sha`. Balance uses the same bound key without OIDC. The client accepts only `https://coinpayportal.com`, rejects redirects and caps response size.

Contribution commands require a fresh permission lookup; `author_association` alone never authorizes them. Bots and edited comments cannot settle. GitHub bot authors can accrue when their PR is actually merged; immutable contributor identity owns the balance.

Only the two named credentials are passed, never `secrets: inherit`. Keys, OIDC tokens and recipient addresses do not appear in replies or diagnostics. Missing setup produces an Actions notice; it does not prove enrollment or production payment readiness.

## Legacy invoice commands

The Action still supports separate invoice/payment commands described in the [README](../README.md). Dedicated contribution keys authorize accrual, balance and manual settlement only. They do **not** grant generic merchant payment/invoice access; legacy commands require separate credentials with their own permissions. Keep formal `githubInvoices` disabled for this rollout. Neither a legacy invoice nor a standalone payment counts as ledger reward settlement.

## Validation

`test:workflow` executes the actual reusable-workflow scripts against adversarial GitHub fixtures. Action tests cover strict config, current identity/permission, fixed transport, integer arithmetic and retry behavior. After `build`, `test:bundle` executes the actual committed `dist/index.js` for accrual, replay, balance, settlement and rejection paths with all real network connections denied. These checks create no production comments, ledger entries or payments.
