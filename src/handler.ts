/**
 * Command orchestration. Pure of transport concerns — it depends only on the
 * injected CoinPayClient and GitHubClient interfaces, so the whole flow is
 * exercised end-to-end in tests with in-memory fakes.
 */

import type { ResolvedConfig } from './config.js';
import { createHash } from 'node:crypto';
import type {
  GitHubClient,
  IssueRef,
  PullRequestContext,
  ThreadComment,
} from './github.js';
import { CoinPayClient, CoinPayError } from './coinpay.js';
import { isValidGithubLogin, parseCommand } from './parser.js';
import type { InvoiceCommand, PublishInvoiceCommand } from './parser.js';
import { canCreateDirectly, canApprove, canCancel } from './permissions.js';
import type { AuthorAssociation } from './permissions.js';
import * as render from './render.js';
import type { PendingRequest } from './render.js';

export interface CommentEvent {
  ref: IssueRef;
  /** Immutable repository id, independent of renames and transfers. */
  repositoryId?: number;
  commentId: number;
  body: string;
  actor: string;
  /** Immutable numeric GitHub user id of the comment author (audit identity). */
  actorId?: number;
  /** GitHub account type of the comment author: 'User', 'Bot', ... */
  actorType?: string;
  authorAssociation: AuthorAssociation;
  /** Canonical URL of the issue/PR, used as the payer redirect target. */
  issueUrl: string;
  isPullRequest: boolean;
}

export interface HandlerDeps {
  coinpay: CoinPayClient;
  github: GitHubClient;
  config: ResolvedConfig;
}

export type Action =
  | 'skipped'
  | 'help'
  | 'invoice_created'
  | 'invoice_published'
  | 'invoice_already_closed'
  | 'dry_run'
  | 'request_pending'
  | 'approved'
  | 'status'
  | 'cancelled'
  | 'error'
  | 'noop_duplicate'
  | 'noop_disabled';

export interface HandlerResult {
  action: Action;
  detail?: string;
  paymentId?: string;
  invoiceId?: string;
}

export async function handleComment(evt: CommentEvent, deps: HandlerDeps): Promise<HandlerResult> {
  const parsed = parseCommand(evt.body);
  if (parsed.kind === 'error' && parsed.code === 'not_a_command') {
    return { action: 'skipped' };
  }
  if (!deps.config.enabled) {
    return { action: 'noop_disabled' };
  }

  // Idempotency (FR-008): if we already replied to this comment id, stop.
  const existing = await deps.github.listComments(evt.ref);
  if (render.isHandled(existing, evt.commentId)) {
    return { action: 'noop_duplicate' };
  }

  if (parsed.kind === 'error') {
    // The @payer invoice flow never replies to non-human commenters, even
    // with usage errors, so misfiring integrations cannot start reply loops.
    if (parsed.flow === 'publish_invoice' && !isHumanActor(evt)) {
      return { action: 'skipped', detail: 'non_human_commenter' };
    }
    await deps.github.createComment(evt.ref, render.errorComment(parsed.message, evt.commentId));
    return { action: 'error', detail: parsed.code };
  }

  switch (parsed.kind) {
    case 'help':
      await deps.github.createComment(evt.ref, render.helpComment(evt.commentId));
      return { action: 'help' };
    case 'invoice':
      return handleInvoice(parsed, evt, deps, existing);
    case 'publish_invoice':
      return handlePublishInvoice(parsed, evt, deps);
    case 'approve':
      return handleApprove(evt, deps, existing);
    case 'status':
      return handleStatus(evt, deps, existing);
    case 'cancel':
      return handleCancel(evt, deps, existing);
  }
}

/** GitHub `user.type` for humans is exactly 'User'; anything else fails closed. */
function isHumanActor(evt: CommentEvent): boolean {
  return (evt.actorType ?? '').toLowerCase() === 'user';
}

async function handleInvoice(
  cmd: InvoiceCommand,
  evt: CommentEvent,
  deps: HandlerDeps,
  existing: ThreadComment[],
): Promise<HandlerResult> {
  if (!deps.config.commands.invoice) {
    await deps.github.createComment(evt.ref, render.errorComment('The `invoice` command is disabled for this repository.', evt.commentId));
    return { action: 'error', detail: 'command_disabled' };
  }

  const crypto = cmd.crypto ?? deps.config.defaultCrypto;
  const direct = canCreateDirectly(evt.authorAssociation, deps.config.minRoleToCreateInvoice);

  // Keep this gate independent of today's required --wallet flag. Otherwise a
  // future parser change could accidentally make PR-backed creation available
  // to contributors without going through the approval flow.
  if (cmd.source === 'create' && !direct) {
    await deps.github.createComment(
      evt.ref,
      render.errorComment(
        'Only a repository maintainer may create a PR-backed invoice directly.',
        evt.commentId,
      ),
    );
    return { action: 'error', detail: 'unauthorized_create' };
  }

  if (cmd.wallet && !direct) {
    await deps.github.createComment(
      evt.ref,
      render.errorComment(
        'Only a repository maintainer may supply an explicit receiving wallet. Ask a maintainer to run the command directly.',
        evt.commentId,
      ),
    );
    return { action: 'error', detail: 'unauthorized_wallet' };
  }

  if (cmd.source === 'create') {
    if (!evt.isPullRequest) {
      await deps.github.createComment(
        evt.ref,
        render.errorComment('`/coinpay create` must be run on a pull request.', evt.commentId),
      );
      return { action: 'error', detail: 'not_a_pull_request' };
    }

    let pullRequest: PullRequestContext | null;
    try {
      pullRequest = await deps.github.getPullRequestContext(evt.ref);
    } catch {
      await deps.github.createComment(
        evt.ref,
        render.errorComment(
          'Could not read this pull request and its linked issues. Check the Action permissions and try again.',
        ),
      );
      return { action: 'error', detail: 'github_read_failed' };
    }
    if (!pullRequest) {
      await deps.github.createComment(
        evt.ref,
        render.errorComment('Could not resolve this pull request.', evt.commentId),
      );
      return { action: 'error', detail: 'pull_request_not_found' };
    }

    const description = render.pullRequestSummary(pullRequest);
    const request: PendingRequest = {
      amount: cmd.amount,
      fiat: cmd.fiat,
      crypto,
      description,
      wallet: cmd.wallet,
      requester: evt.actor,
      commentId: evt.commentId,
    };
    const idempotencyKey = paymentIdempotencyKey(evt.ref, request);
    if (render.hasPaymentMarker(existing, idempotencyKey)) {
      return { action: 'noop_duplicate' };
    }
    if (cmd.dryRun) {
      await deps.github.createComment(
        evt.ref,
        render.dryRunComment({
          amount: request.amount,
          fiat: request.fiat,
          crypto: request.crypto,
          wallet: request.wallet!,
          description,
          source: pullRequest,
          idempotencyKey,
          handledCommentId: evt.commentId,
        }),
      );
      return { action: 'dry_run' };
    }
    return createPaymentAndReply(
      request,
      evt,
      deps,
      existing,
      pullRequest,
      idempotencyKey,
    );
  }

  if (!direct && deps.config.requireApprovalForNonMaintainers) {
    const req: PendingRequest = {
      amount: cmd.amount,
      fiat: cmd.fiat,
      crypto,
      description: cmd.description,
      wallet: cmd.wallet,
      requester: evt.actor,
      commentId: evt.commentId,
    };
    await deps.github.createComment(
      evt.ref,
      render.pendingComment({ request: req, approveCommand: '/coinpay approve', handledCommentId: evt.commentId }),
    );
    await deps.github.addLabels(evt.ref, [deps.config.labels.requested]);
    return { action: 'request_pending' };
  }

  return createPaymentAndReply(
    {
      amount: cmd.amount,
      fiat: cmd.fiat,
      crypto,
      description: cmd.description,
      wallet: cmd.wallet,
      requester: evt.actor,
      commentId: evt.commentId,
    },
    evt,
    deps,
    existing,
  );
}

/**
 * Stable invoice identity for CoinPayPortal's `Idempotency-Key`: repository ID +
 * comment id ONLY. It survives process restarts and redeliveries because it is
 * derived, not stored — and it deliberately excludes the terms, so a key reuse
 * with different terms is rejected by the API (409) instead of silently
 * creating a second invoice.
 */
export function githubInvoiceIdempotencyKey(repositoryId: number, commentId: number): string {
  return `github:repository:${repositoryId}:comment:${commentId}`;
}

function canonicalThreadUrl(ref: IssueRef, isPullRequest: boolean): string {
  return `https://github.com/${ref.owner}/${ref.repo}/${isPullRequest ? 'pull' : 'issues'}/${ref.issueNumber}`;
}

/**
 * `/coinpay create @payer <amount> "<description>"` — create and publish a
 * CoinPayPortal invoice issued by the repository's configured business.
 *
 * Open to every human commenter by design (no role gate): the safeguards are
 * non-identity ones — the feature flag, the per-invoice amount cap, the
 * portal-enforced per-repository hourly cap, strict parsing, and one invoice
 * per source comment via API idempotency. The commenter's own CoinPay account
 * is never involved; no GitHub-to-CoinPay account mapping exists.
 */
async function handlePublishInvoice(
  cmd: PublishInvoiceCommand,
  evt: CommentEvent,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  // Only human-authored, newly created comments qualify; the Action entrypoint
  // already drops edited comments, and bots are dropped here without a reply.
  if (!isHumanActor(evt)) {
    return { action: 'skipped', detail: 'non_human_commenter' };
  }

  const settings = deps.config.githubInvoices;
  if (!settings.enabled) {
    await deps.github.createComment(
      evt.ref,
      render.errorComment(
        'The `/coinpay create @payer …` invoice command is not enabled for this repository. A maintainer can enable it by setting `githubInvoices.enabled: true` in `.github/coinpay.yml` — but only after the CoinPayPortal idempotent invoice deployment (API + migration) is live, or every command will fail.',
        evt.commentId,
      ),
    );
    return { action: 'noop_disabled', detail: 'github_invoices_disabled' };
  }

  // The immutable numeric actor id is mandatory audit data; fail closed
  // rather than record an invoice that cannot be attributed.
  if (!Number.isSafeInteger(evt.actorId) || evt.actorId! <= 0 || !isValidGithubLogin(evt.actor)
      || !Number.isSafeInteger(evt.repositoryId) || evt.repositoryId! <= 0
      || !Number.isSafeInteger(evt.commentId) || evt.commentId <= 0) {
    await deps.github.createComment(
      evt.ref,
      render.errorComment(
        'Could not verify the GitHub actor, repository, and comment identities, so no invoice was created.',
        evt.commentId,
      ),
    );
    return { action: 'error', detail: 'missing_actor_identity' };
  }

  if (cmd.amount > settings.maxAmountUsd) {
    await deps.github.createComment(
      evt.ref,
      render.errorComment(
        `The amount ${cmd.amount.toFixed(2)} USD exceeds this repository’s per-invoice maximum of ${settings.maxAmountUsd.toFixed(2)} USD (config: \`githubInvoices.maxAmountUsd\`).`,
        evt.commentId,
      ),
    );
    return { action: 'error', detail: 'amount_over_limit' };
  }

  const threadUrl = canonicalThreadUrl(evt.ref, evt.isPullRequest);
  const threadLabel = `${evt.ref.owner}/${evt.ref.repo}#${evt.ref.issueNumber}`;
  const idempotencyKey = githubInvoiceIdempotencyKey(evt.repositoryId!, evt.commentId);

  if (cmd.dryRun) {
    await deps.github.createComment(
      evt.ref,
      render.githubInvoiceDryRunComment({
        payer: cmd.payer,
        amount: cmd.amount,
        description: cmd.description,
        crypto: deps.config.defaultCrypto,
        threadUrl,
        threadLabel,
        idempotencyKey,
        handledCommentId: evt.commentId,
      }),
    );
    return { action: 'dry_run' };
  }

  try {
    const created = await deps.coinpay.createInvoice({
      amountUsd: cmd.amount,
      cryptoCurrency: deps.config.defaultCrypto,
      // Stable notes: sanitized description + canonical thread/comment URL.
      notes: `${cmd.description}\n\n${threadUrl}#issuecomment-${evt.commentId}`,
      source: {
        repository: `${evt.ref.owner}/${evt.ref.repo}`,
        threadNumber: evt.ref.issueNumber,
        commentId: evt.commentId,
        actorId: evt.actorId!,
        actorLogin: evt.actor,
        payerLogin: cmd.payer,
      },
      sourceRateLimit: settings.repositoryHourlyCap,
      idempotencyKey,
    });

    // A replayed invoice may have closed since (paid/cancelled/...): report
    // it, never republish it, and never post a payment link for it.
    if (created.status !== 'draft' && created.status !== 'sent') {
      await deps.github.createComment(
        evt.ref,
        render.githubInvoiceExistsComment({
          invoiceNumber: created.invoiceNumber,
          status: created.status,
          handledCommentId: evt.commentId,
        }),
      );
      return { action: 'invoice_already_closed', detail: created.status, invoiceId: created.invoiceId };
    }

    // Publish is idempotent for draft and sent; the adapter refuses to return
    // until the row is verified sent with a payment address for OUR business.
    const published = await deps.coinpay.publishInvoice(created.invoiceId, {
      amountUsd: cmd.amount,
    });

    // Re-check the thread before posting: another delivery may have published
    // and replied while we were talking to CoinPayPortal. Best effort only —
    // GitHub offers no atomic reservation, so a duplicate comment remains
    // possible; the invoice itself stays unique through the idempotency key.
    const latest = await deps.github.listComments(evt.ref);
    if (render.isHandled(latest, evt.commentId)) {
      return { action: 'noop_duplicate', invoiceId: created.invoiceId };
    }

    await deps.github.createComment(
      evt.ref,
      render.githubInvoiceSuccessComment({
        payer: cmd.payer,
        actor: evt.actor,
        amount: cmd.amount,
        description: cmd.description,
        invoiceNumber: published.invoiceNumber,
        paymentLink: published.paymentLink,
        pdfLink: settings.pdfEnabled ? deps.coinpay.invoicePdfLink(published.invoiceId) ?? undefined : undefined,
        feeRate: published.feeRate,
        feeAmountUsd: published.feeAmountUsd,
        threadUrl,
        threadLabel,
        handledCommentId: evt.commentId,
      }),
    );
    await deps.github.addLabels(evt.ref, [deps.config.labels.pending]);
    return { action: 'invoice_published', invoiceId: created.invoiceId };
  } catch (err) {
    // No fallback path: a failed invoice flow never falls through to the
    // legacy payment API. The comment carries fixed text only — raw API
    // errors, keys, and addresses are not printed in the Action log either.
    await deps.github.createComment(evt.ref, render.errorComment(friendlyInvoiceError(err)));
    await deps.github.addLabels(evt.ref, [deps.config.labels.error]);
    return { action: 'error', detail: err instanceof CoinPayError ? err.code : 'unknown' };
  }
}

/** Fixed, safe comment text per invoice-flow failure mode. Never raw API text. */
export function friendlyInvoiceError(err: unknown): string {
  const retry = 'Ask a maintainer to re-run this same GitHub Actions run, not post a new command comment. Only the same source comment reuses the invoice.';
  if (err instanceof CoinPayError) {
    switch (err.code) {
      case 'NO_WALLET':
        return 'The repository’s CoinPayPortal business has no receiving wallet for the configured crypto. A maintainer can add one in CoinPayPortal settings. ' + retry;
      case 'AUTH':
        return 'CoinPayPortal rejected the API key. Check the `COINPAY_API_KEY` secret for this repository.';
      case 'BAD_REQUEST':
        return 'CoinPayPortal rejected the invoice terms or configuration. A maintainer should check the command, business settings, and existing invoice before trying again. Re-running an unchanged invalid request will not fix it. No payment link was posted.';
      case 'RATE_LIMIT':
        return 'This repository’s hourly invoice cap has been reached. Wait for the window to pass. ' + retry;
      case 'IDEMPOTENCY_CONFLICT':
        return 'An invoice was already recorded for this comment with different terms, so no new invoice was created. Check the existing invoice in CoinPayPortal before requesting a replacement.';
      case 'INVOICE_DELETED':
        return 'The invoice originally created from this comment was deleted in CoinPayPortal and will not be recreated automatically. Post a new comment if payment is still owed.';
      case 'UNAVAILABLE':
        return 'CoinPayPortal cannot confirm idempotent invoice creation right now (the deployment or migration may still be rolling out). ' + retry;
      case 'PUBLISH_RETRY':
        return 'The invoice exists but its payment details are still being prepared. ' + retry;
      case 'NOT_PUBLISHABLE':
        return 'The invoice created from this comment is already closed and stays closed. No payment link was posted.';
      case 'INVALID_RESPONSE':
        return 'CoinPayPortal returned an unexpected response, so no payment link was posted. ' + retry;
      case 'NETWORK':
        return 'Could not reach CoinPayPortal; creation may have completed before the connection failed. ' + retry;
      case 'SERVER':
        return 'CoinPayPortal had an internal error. ' + retry;
      default:
        return 'CoinPayPortal could not confirm invoice creation. ' + retry;
    }
  }
  return 'An unexpected error occurred during invoice creation or reply delivery. ' + retry;
}

async function handleApprove(evt: CommentEvent, deps: HandlerDeps, existing: ThreadComment[]): Promise<HandlerResult> {
  if (!canApprove(evt.authorAssociation)) {
    await deps.github.createComment(evt.ref, render.errorComment(`@${evt.actor} is not authorized to approve invoice requests.`, evt.commentId));
    return { action: 'error', detail: 'unauthorized_approve' };
  }
  const req = render.findPendingRequest(existing);
  if (!req) {
    await deps.github.createComment(evt.ref, render.errorComment('No pending invoice request found in this thread.', evt.commentId));
    return { action: 'error', detail: 'no_pending_request' };
  }
  if (req.wallet) {
    await deps.github.createComment(
      evt.ref,
      render.errorComment(
        'A pending contributor request cannot select a receiving wallet. Run a new maintainer-authored invoice command instead.',
        evt.commentId,
      ),
    );
    return { action: 'error', detail: 'untrusted_pending_wallet' };
  }
  await deps.github.addLabels(evt.ref, [deps.config.labels.approved]);
  return createPaymentAndReply(req, evt, deps, existing);
}

async function handleStatus(evt: CommentEvent, deps: HandlerDeps, _existing: ThreadComment[]): Promise<HandlerResult> {
  // Pull-only status (Action MVP can't receive webhooks — PRD §16 v0.2).
  await deps.github.createComment(
    evt.ref,
    render.errorComment('Live status requires the hosted CoinPayPortal GitHub App. In Action mode, check the payment link directly.', evt.commentId),
  );
  return { action: 'status' };
}

async function handleCancel(evt: CommentEvent, deps: HandlerDeps, existing: ThreadComment[]): Promise<HandlerResult> {
  if (!canCancel(evt.authorAssociation)) {
    await deps.github.createComment(evt.ref, render.errorComment(`@${evt.actor} is not authorized to cancel.`, evt.commentId));
    return { action: 'error', detail: 'unauthorized_cancel' };
  }
  const req = render.findPendingRequest(existing);
  if (!req) {
    await deps.github.createComment(evt.ref, render.errorComment('No pending invoice request to cancel in this thread.', evt.commentId));
    return { action: 'error', detail: 'no_pending_request' };
  }
  await deps.github.addLabels(evt.ref, [deps.config.labels.cancelled]);
  await deps.github.createComment(evt.ref, render.errorComment(`Pending request from @${req.requester} cancelled.`, evt.commentId));
  return { action: 'cancelled' };
}

async function createPaymentAndReply(
  req: PendingRequest,
  evt: CommentEvent,
  deps: HandlerDeps,
  existing: ThreadComment[],
  pullRequest?: PullRequestContext,
  requestedIdempotencyKey?: string,
): Promise<HandlerResult> {
  const idempotencyKey = requestedIdempotencyKey
    ?? legacyPaymentIdempotencyKey(evt.ref, req);
  if (render.hasPaymentMarker(existing, idempotencyKey)) {
    return { action: 'noop_duplicate' };
  }
  try {
    const result = await deps.coinpay.createPayment({
      amountUsd: req.amount,
      crypto: req.crypto,
      description: req.description,
      redirectUrl: evt.issueUrl,
      walletAddress: req.wallet,
      idempotencyKey,
      metadata: render.invoiceMetadata({
        owner: evt.ref.owner,
        repo: evt.ref.repo,
        issueNumber: evt.ref.issueNumber,
        commentId: req.commentId,
        actor: req.requester,
        idempotencyKey,
        pullRequest,
      }),
    });

    await deps.github.createComment(
      evt.ref,
      render.successComment({
        amount: req.amount,
        fiat: req.fiat,
        crypto: req.crypto,
        description: req.description,
        paymentId: result.paymentId,
        payLink: result.payLink,
        actor: req.requester,
        handledCommentId: evt.commentId,
        idempotencyKey,
        source: pullRequest,
      }),
    );
    await deps.github.addLabels(evt.ref, [deps.config.labels.pending]);
    return { action: 'invoice_created', paymentId: result.paymentId };
  } catch (err) {
    const msg = friendlyError(err);
    await deps.github.createComment(evt.ref, render.errorComment(msg));
    await deps.github.addLabels(evt.ref, [deps.config.labels.error]);
    return { action: 'error', detail: err instanceof CoinPayError ? err.code : 'unknown' };
  }
}

function legacyPaymentIdempotencyKey(
  ref: IssueRef,
  request: Pick<PendingRequest, 'amount' | 'fiat' | 'crypto' | 'wallet' | 'commentId'>,
): string {
  return hashPaymentIdentity([
    ref.owner.toLowerCase(),
    ref.repo.toLowerCase(),
    String(ref.issueNumber),
    String(request.commentId),
    request.amount.toString(),
    request.fiat.toUpperCase(),
    request.crypto.toLowerCase(),
    request.wallet?.trim() ?? '',
  ]);
}

export function paymentIdempotencyKey(
  ref: IssueRef,
  request: Pick<PendingRequest, 'amount' | 'fiat' | 'crypto' | 'wallet'>,
): string {
  const identity = [
    ref.owner.toLowerCase(),
    ref.repo.toLowerCase(),
    String(ref.issueNumber),
    request.amount.toString(),
    request.fiat.toUpperCase(),
    request.crypto.toLowerCase(),
    request.wallet?.trim() ?? '',
  ];
  return hashPaymentIdentity(identity);
}

function hashPaymentIdentity(identity: string[]): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Translate adapter errors into safe, actionable maintainer-facing text (PRD §18). */
export function friendlyError(err: unknown): string {
  if (err instanceof CoinPayError) {
    switch (err.code) {
      case 'NO_WALLET':
        return 'No receiving wallet is configured for that cryptocurrency on your CoinPayPortal business. Add a wallet in CoinPayPortal settings, choose a different `--crypto`, or pass `--wallet <address>`.';
      case 'LIMIT':
        return 'Your CoinPayPortal plan\'s monthly transaction limit has been reached. Upgrade your plan or wait for the next cycle.';
      case 'STRIPE_NOT_CONNECTED':
        return 'Card payments require Stripe Connect. Complete Stripe onboarding in CoinPayPortal, or use crypto.';
      case 'AUTH':
        return 'CoinPayPortal rejected the API key. Check the `COINPAY_API_KEY` secret for this repository.';
      case 'NETWORK':
        return 'Could not reach CoinPayPortal. Please try again.';
      default:
        return 'CoinPayPortal could not create the payment. Check the service logs and try again.';
    }
  }
  return 'An unexpected error occurred while creating the payment.';
}
