# Pull-only invoice status

After updating an installation to a reviewed Action commit, new successful
`/coinpay create @payer ...` replies contain a versioned invoice reference.
`/coinpay status` on that PR reads the newest reference and reports only invoice
number, USD amount, status, checked-at time and the canonical live link.
The default-off `githubInvoices.pdfEnabled` flag also includes the PDF snapshot
link. The snapshot is not a receipt and is not fetched by the bot.

Older replies, including legacy `/coinpay invoice` payments, are not migrated.
Use their existing payment page. The supplied reusable workflow handles PR
comments; this release does not add an issue workflow. Unsupported issue events
or custom adapters without bounded status reads are skipped without a reply.
Merging this repository
does not update installations pinned to an older Action SHA.

The installed API key needs `business.read` and the deployed Portal GET must
expose the validated `metadata.source_reference` contract described in
`src/coinpay.ts`. A verified upstream commit is not proof of production rollout;
missing permission or incompatible deployment reports unavailable, not success.

The status path does not create or modify invoices, email payers, move money,
read payment/chain APIs, or change labels. `paid` means marked paid in Portal,
not independently confirmed settlement or forwarding to a wallet.

## Privacy and failure states

The bot checks numeric posting identity, configured business, invoice ID and
stored GitHub source context. It verifies the original creation comment's ID,
numeric author, thread URL and timestamp (up to 60 seconds of clock skew).
Markers alone are not authentication: other workflows can share a bot identity.
Portal source metadata currently stores repository names rather than immutable
repository IDs. Renames/transfers that no longer match fail closed. This path
targets github.com; GitHub Enterprise Server source URLs are not supported.

Only `sent`, `overdue` and `paid` invoices are projected. Unknown/private states,
wrong source/business, deleted invoices or source comments, bad responses and
permission/network failures produce a generic unavailable message without a
new payment/PDF link or private customer/metadata fields. A newest closed
invoice never falls back to an older payable one.

Lookup considers the latest 100 comments, using at most three bounded comment
pages, one bot identity lookup and one original-comment verification. The newest
invoice is selected by its original creation comment ID, not the order in which
concurrent bot replies arrived. It makes
one invoice GET with a 10-second deadline and a 64 KiB response limit. A busy
thread may push the original reply out of the window; use its existing payment
page then. GitHub reads use 10-second abort signals. The configured Portal origin
must be HTTPS without credentials, query, fragment or a subpath (localhost HTTP
is allowed for local tests). Redirects are rejected, never followed with the key.
GitHub documents its
[issue comment API and pagination](https://docs.github.com/en/rest/issues/comments#list-issue-comments).

Status honors `enabled`, `commands.status`, human filtering and handled markers.
A trusted status reply suppresses further status reads/replies for 60 seconds
using GitHub's creation timestamp. This is a best-effort per-thread cooldown,
not a durable global quota or cross-runner lock. The reusable workflow retains
its existing collaborator permission check and per-thread concurrency. No new
role or paid-tier restriction is added to the library. Custom runners must
still serialize same-thread deliveries themselves.

## Validation

Run typecheck, full Vitest suite, workflow checks, build and built-bundle tests
before adoption. Tests use fake GitHub/Portal responses, including private data
sentinels, forged markers, multi-page threads and stalled responses. Do not run
a live invoice command as a deployment smoke test without approval.

`test/status-http.test.ts` additionally runs real Node fetch against localhost,
using a fake key. It covers ten-second header/body deadlines, socket cleanup,
chunked and gzip decoded-size limits, UTF-8, truncated bodies, HTTP failures and
exactly one read request per attempt. No real invoice or payment is involved.
The built-Action fixtures also ignore transport aborts and deliver headers after
the deadline: the Action must explicitly cancel bodies, avoid reading late
responses and produce exactly one unavailable reply with no payment/PDF link.
