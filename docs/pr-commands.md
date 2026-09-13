# Shared workflow for manual PR commands

The reusable [PR workflow](../.github/workflows/pr-commands.yml) runs CoinPay
commands only for new human-authored PR comments whose author currently has
GitHub **write, maintain, or admin permission** on the calling repository.
This additional gate verifies permissions with GitHub instead of trusting
`author_association` alone. Permission lookup failure stops the action.

Each repository needs a small caller, its own configuration and approved
credentials. The common job, permission/setup checks and tests stay here.
Application source, automatic PR rates and automatic billing events are unchanged.

## Install

Copy [the caller example](../examples/coinpay-pr-commands.yml) to the repository's
`.github/workflows/coinpay.yml`. Replace `REVIEWED_COMMIT_SHA` with a reviewed full
40-character commit containing this reusable workflow. Do not use the older `v0`
tag: it predates this workflow and the newer PR payment commands.

Pass only the two named secrets, `COINPAY_API_KEY` and `COINPAY_BUSINESS_ID`, from
repository secrets or organization secrets available to that repository. The
workflow automatically uses the caller's `GITHUB_TOKEN`; it never checks out or
executes the PR's code. Missing CoinPay credentials produce a setup notice in the
Actions run and skip the action. This is not proof that live invoicing works.

Keep `.github/coinpay.yml` on the caller's default branch:

```yaml
enabled: true
defaultFiat: USD
defaultCrypto: usdc_pol
minRoleToCreateInvoice: collaborator
requireApprovalForNonMaintainers: true
githubInvoices:
  enabled: false
```

The `collaborator` association setting does not bypass the reusable workflow's
current-write-permission lookup. The upstream formal `@payer` invoice feature
remains disabled; its business-issued invoice does not link contributor accounts.
The reusable workflow inherits the caller's event/repository context and reads
that repository's configuration. It ignores bots, edited comments, issue-only
threads and non-command text. Only the called job sets its per-PR concurrency
group; callers need not duplicate it.

## Explicit contribution payments

After independently verifying the contributor's receiving address and agreed
amount, a maintainer comments on the PR:

```text
/coinpay create 25 USD --crypto usdc_pol --wallet <verified-contributor-address> --dry-run
```

The amount is an example, not a default rate. Preview posts a GitHub reply but
makes no CoinPay API call. After reviewing it, the maintainer posts a new command
without `--dry-run` to create the payment link. The owner then pays through that
link; the bot does not transfer funds. Verify the settlement chain and platform
fee before payment.

The explicit wallet determines the recipient. A legacy `/coinpay invoice`
command without a wallet defaults to the configured business wallet, so it must
not be presented as contributor payment. Numeric PR commands create payment
resources, not formal invoice records. Current deduplication covers identical
PR/amount/coin/wallet terms; it does not establish one entitlement per PR across
changed terms or repository renames. Automatic PR rates, contributor account
linking, and invoice entitlement tracking require separate changes.

## Checks

`pnpm run test:workflow` executes the actual inline authorization/setup scripts
against mocked permissions and fake credentials. It makes no network requests
and creates no comments, invoices or payments. CI runs it alongside the existing
action tests and committed-bundle verification. Consumer repositories do not need
copies of those tests.

GitHub documents the [caller context and permission limits](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#github-context)
and [immutable workflow references](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
