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
import { parseCommand } from './parser.js';
import type { InvoiceCommand } from './parser.js';
import { canCreateDirectly, canApprove, canCancel } from './permissions.js';
import type { AuthorAssociation } from './permissions.js';
import * as render from './render.js';
import type { PendingRequest } from './render.js';

export interface CommentEvent {
  ref: IssueRef;
  commentId: number;
  body: string;
  actor: string;
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
    await deps.github.createComment(evt.ref, render.errorComment(parsed.message, evt.commentId));
    return { action: 'error', detail: parsed.code };
  }

  switch (parsed.kind) {
    case 'help':
      await deps.github.createComment(evt.ref, render.helpComment(evt.commentId));
      return { action: 'help' };
    case 'invoice':
      return handleInvoice(parsed, evt, deps, existing);
    case 'approve':
      return handleApprove(evt, deps, existing);
    case 'status':
      return handleStatus(evt, deps, existing);
    case 'cancel':
      return handleCancel(evt, deps, existing);
  }
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
