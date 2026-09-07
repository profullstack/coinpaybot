/**
 * Renders GitHub comment bodies (PRD §9) and embeds hidden machine-readable
 * markers so the Action can stay stateless (no database in the MVP):
 *
 *  - HANDLED marker: dedupes repeated events by triggering comment id (FR-008).
 *  - REQUEST marker: lets `/coinpay approve` recover the pending invoice's terms
 *    by scanning the thread, instead of a persisted request record.
 */

import {
  isCanonicalUsdAmount,
  SUPPORTED_CRYPTO,
  type InvoiceCommand,
} from './parser.js';
import {
  isTrustedAuthor,
  type PullRequestContext,
  type ThreadComment,
} from './github.js';

export interface PendingRequest {
  amount: number;
  fiat: string;
  crypto: string;
  description?: string;
  wallet?: string;
  requester: string;
  /** id of the comment that requested the invoice. */
  commentId: number;
}

const HANDLED_RE = /<!--\s*coinpay:handled\s+(\d+)\s*-->/g;
const REQUEST_RE = /<!--\s*coinpay:request\s+(\{.*?\})\s*-->/s;
const REQUEST_V2_RE = /<!--\s*coinpay:request:v2\s+([A-Za-z0-9_-]+)\s*-->/;
const PAYMENT_RE = /<!--\s*coinpay:payment\s+([a-f0-9]{64})\s*-->/g;

function trustedBodies(comments: ThreadComment[]): string[] {
  return comments.filter(isTrustedAuthor).map((comment) => comment.body);
}

export function handledMarker(commentId: number): string {
  return `<!-- coinpay:handled ${commentId} -->`;
}

/** Has any of these existing comment bodies already handled `commentId`? */
export function isHandled(comments: ThreadComment[], commentId: number): boolean {
  for (const body of trustedBodies(comments)) {
    HANDLED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HANDLED_RE.exec(body)) !== null) {
      if (Number(m[1]) === commentId) return true;
    }
  }
  return false;
}

export function requestMarker(req: PendingRequest): string {
  const encoded = Buffer.from(JSON.stringify(req), 'utf8').toString('base64url');
  return `<!-- coinpay:request:v2 ${encoded} -->`;
}

/** Recover the most recent pending request embedded in the thread, if any. */
export function findPendingRequest(comments: ThreadComment[]): PendingRequest | null {
  const existingBodies = trustedBodies(comments);
  for (let i = existingBodies.length - 1; i >= 0; i--) {
    const body = existingBodies[i] ?? '';
    const encoded = REQUEST_V2_RE.exec(body)?.[1];
    const legacy = REQUEST_RE.exec(body)?.[1];
    if (encoded || legacy) {
      try {
        const value = JSON.parse(
          encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : legacy!,
        ) as unknown;
        if (isPendingRequest(value)) return value;
      } catch {
        /* ignore malformed marker */
      }
    }
  }
  return null;
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<PendingRequest>;
  return (
    isCanonicalUsdAmount(request.amount) &&
    request.fiat === 'USD' &&
    typeof request.crypto === 'string' &&
    SUPPORTED_CRYPTO.has(request.crypto) &&
    typeof request.requester === 'string' &&
    request.requester.trim().length > 0 &&
    Number.isSafeInteger(request.commentId) &&
    request.commentId! > 0 &&
    (request.wallet === undefined || typeof request.wallet === 'string') &&
    (request.description === undefined || typeof request.description === 'string')
  );
}

export function paymentMarker(idempotencyKey: string): string {
  return `<!-- coinpay:payment ${idempotencyKey} -->`;
}

export function hasPaymentMarker(
  comments: ThreadComment[],
  idempotencyKey: string,
): boolean {
  for (const body of trustedBodies(comments)) {
    PAYMENT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAYMENT_RE.exec(body)) !== null) {
      if (match[1] === idempotencyKey) return true;
    }
  }
  return false;
}

function neutralizeHtmlComments(value: string): string {
  return value.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function cleanSummaryText(value: string): string {
  const flattened = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return neutralizeHtmlComments(flattened);
}

function markdownLinkText(value: string): string {
  return cleanSummaryText(value).replace(/[\\\[\]]/g, '\\$&');
}

function markdownCodeText(value: string): string {
  return cleanSummaryText(value).replace(/`/g, '&#96;');
}

/** Render untrusted prose without allowing links or any other Markdown. */
function markdownCodeSpan(value: string): string {
  const text = cleanSummaryText(value);
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}

export function pullRequestSummary(context: PullRequestContext): string {
  const parts = [`PR #${context.number}: ${cleanSummaryText(context.title)}`];
  for (const issue of context.linkedIssues) {
    parts.push(
      `Issue ${issue.owner}/${issue.repo}#${issue.number}: ${cleanSummaryText(issue.title)}`,
    );
  }
  return parts.join(' | ').slice(0, 5000);
}

function sourceLines(context?: PullRequestContext): string[] {
  if (!context) return [];
  return [
    `**Work:** [PR #${context.number}: ${markdownLinkText(context.title)}](${context.url})  `,
    ...context.linkedIssues.map(
      (issue) =>
        `**Linked issue:** [${issue.owner}/${issue.repo}#${issue.number}: ${markdownLinkText(issue.title)}](${issue.url})  `,
    ),
  ];
}

function fmtAmount(amount: number, fiat: string): string {
  return `${amount.toFixed(2)} ${fiat}`;
}

export function successComment(args: {
  amount: number; fiat: string; crypto: string; description?: string;
  paymentId: string; payLink: string; actor: string; handledCommentId: number;
  idempotencyKey: string; source?: PullRequestContext;
}): string {
  return [
    '### CoinPayPortal invoice created',
    '',
    `**Amount:** ${fmtAmount(args.amount, args.fiat)}  `,
    `**Crypto:** ${cleanSummaryText(args.crypto)}  `,
    ...(args.description
      ? [`**Description:** ${markdownCodeSpan(args.description)}  `]
      : []),
    ...sourceLines(args.source),
    `**Payment ID:** \`${markdownCodeText(args.paymentId)}\``,
    '',
    `**Pay here:** ${cleanSummaryText(args.payLink)}`,
    '',
    `_Triggered by @${cleanSummaryText(args.actor)}_`,
    '',
    handledMarker(args.handledCommentId),
    paymentMarker(args.idempotencyKey),
  ].join('\n');
}

export function dryRunComment(args: {
  amount: number;
  fiat: string;
  crypto: string;
  wallet: string;
  description: string;
  source: PullRequestContext;
  idempotencyKey: string;
  handledCommentId: number;
}): string {
  return [
    '### CoinPayPortal invoice preview',
    '',
    '**Dry run:** no payment was created and no labels were changed.  ',
    `**Amount:** ${fmtAmount(args.amount, args.fiat)}  `,
    `**Crypto:** ${cleanSummaryText(args.crypto)}  `,
    `**Wallet:** \`${markdownCodeText(args.wallet)}\`  `,
    `**Description:** ${markdownCodeSpan(args.description)}  `,
    ...sourceLines(args.source),
    `**Idempotency key:** \`${args.idempotencyKey}\``,
    '',
    handledMarker(args.handledCommentId),
  ].join('\n');
}

/**
 * The honest scope line every GitHub-invoice comment carries: the issuer is
 * the repository's configured CoinPayPortal business (there is no GitHub-to-
 * CoinPay account mapping), and the payer is a mention, not a verified client.
 */
const ISSUER_DISCLOSURE =
  '_Issued by this repository’s configured CoinPayPortal business — not the commenter’s personal account. The payer mention is a GitHub reference only, not a linked CoinPay client._';

function fmtFee(feeRate: number, feeAmountUsd: number): string {
  const percent = (feeRate * 100).toFixed(feeRate * 100 % 1 === 0 ? 0 : 2);
  return `${percent}% (${feeAmountUsd.toFixed(2)} USD)`;
}

export function githubInvoiceSuccessComment(args: {
  payer: string; actor: string; amount: number; description: string;
  invoiceNumber: string; paymentLink: string; feeRate: number; feeAmountUsd: number;
  threadUrl: string; threadLabel: string; handledCommentId: number;
}): string {
  return [
    '### CoinPayPortal invoice published',
    '',
    `@${args.payer} — a CoinPayPortal invoice has been issued to this thread with you as the requested payer.`,
    '',
    `**Invoice:** \`${markdownCodeText(args.invoiceNumber)}\`  `,
    `**Amount:** ${fmtAmount(args.amount, 'USD')}  `,
    `**Description:** ${markdownCodeSpan(args.description)}  `,
    `**Work:** [${markdownLinkText(args.threadLabel)}](${args.threadUrl})  `,
    `**Platform fee:** ${fmtFee(args.feeRate, args.feeAmountUsd)}`,
    '',
    `**Pay here:** ${cleanSummaryText(args.paymentLink)}`,
    '',
    `_Requested by @${cleanSummaryText(args.actor)}_`,
    ISSUER_DISCLOSURE,
    '',
    handledMarker(args.handledCommentId),
  ].join('\n');
}

export function githubInvoiceDryRunComment(args: {
  payer: string; amount: number; description: string; crypto: string;
  threadUrl: string; threadLabel: string; idempotencyKey: string;
  handledCommentId: number;
}): string {
  return [
    '### CoinPayPortal invoice preview',
    '',
    '**Dry run:** no invoice was created, no payment link exists, no labels were changed, and the payer was not notified.  ',
    // Code span keeps the mention inert so GitHub sends no notification.
    `**Payer (not notified):** \`@${markdownCodeText(args.payer)}\`  `,
    `**Amount:** ${fmtAmount(args.amount, 'USD')}  `,
    `**Description:** ${markdownCodeSpan(args.description)}  `,
    `**Crypto:** ${cleanSummaryText(args.crypto)}  `,
    `**Work:** [${markdownLinkText(args.threadLabel)}](${args.threadUrl})  `,
    `**Idempotency key:** \`${markdownCodeText(args.idempotencyKey)}\``,
    '',
    'Run the same command without `--dry-run` to create and publish the invoice.',
    ISSUER_DISCLOSURE,
    '',
    handledMarker(args.handledCommentId),
  ].join('\n');
}

export function githubInvoiceExistsComment(args: {
  invoiceNumber: string; status: string; handledCommentId: number;
}): string {
  return [
    '### CoinPayPortal invoice already exists',
    '',
    `Invoice \`${markdownCodeText(args.invoiceNumber)}\` was already created from this exact comment and is now \`${markdownCodeText(args.status)}\`. It was not reopened and no new payment link was issued. Post a new comment if further payment is owed.`,
    '',
    handledMarker(args.handledCommentId),
  ].join('\n');
}

export function pendingComment(args: {
  request: PendingRequest; approveCommand: string; handledCommentId: number;
}): string {
  const r = args.request;
  return [
    '### CoinPayPortal invoice request pending approval',
    '',
    `@${cleanSummaryText(r.requester)} requested **${fmtAmount(r.amount, r.fiat)}** in **${cleanSummaryText(r.crypto)}** for:`,
    `> ${markdownCodeSpan(r.description ?? '(no description)')}`,
    '',
    `A maintainer can approve this with:`,
    `\`${args.approveCommand}\``,
    '',
    requestMarker(r),
    handledMarker(args.handledCommentId),
  ].join('\n');
}

export function paidComment(args: {
  amount: number; fiat: string; crypto: string; paymentId: string; paidLabel: string;
}): string {
  return [
    '### CoinPayPortal payment received',
    '',
    `**Amount:** ${fmtAmount(args.amount, args.fiat)}  `,
    `**Crypto:** ${cleanSummaryText(args.crypto)}  `,
    `**Status:** Paid / forwarded  `,
    `**Payment ID:** \`${markdownCodeText(args.paymentId)}\``,
    '',
    `This issue has been labeled \`${markdownCodeText(args.paidLabel)}\`.`,
  ].join('\n');
}

export function errorComment(message: string, handledCommentId?: number): string {
  const lines = ['### CoinPayPortal', '', `:warning: ${cleanSummaryText(message)}`];
  if (handledCommentId !== undefined) lines.push('', handledMarker(handledCommentId));
  return lines.join('\n');
}

export function helpComment(handledCommentId?: number): string {
  const lines = [
    '### CoinPayPortal commands',
    '',
    '| Command | Description |',
    '| --- | --- |',
    '| `/coinpay create @payer <amount> "<desc>"` | Publish an invoice from this repository’s configured CoinPayPortal business (when enabled). Anyone may run it; `@payer` is a mention, not a linked account. Add `--dry-run` to preview. |',
    '| `/coinpay create $10 USD --wallet <address>` | On a PR, create an idempotent payment from the PR and linked issue. |',
    '| `/coinpay invoice <amount> USD --crypto <code> --for "<desc>"` | Create (maintainer) or request (contributor) a payment. |',
    '| `/coinpay approve` | Maintainer: approve the pending request in this thread. |',
    '| `/coinpay status` | Show the current payment status for this thread. |',
    '| `/coinpay cancel` | Maintainer: cancel the pending request in this thread. |',
    '| `/coinpay help` | Show this help. |',
    '',
    'Examples:',
    '- `/coinpay create @octocat 25 "Fix the settlement race"`',
    '- `/coinpay create $10 USD --wallet <address> --dry-run`',
    '- `/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"`',
  ];
  if (handledCommentId !== undefined) lines.push('', handledMarker(handledCommentId));
  return lines.join('\n');
}

/** Build the invoice metadata forwarded to CoinPayPortal (PRD §12.2). */
export function invoiceMetadata(args: {
  owner: string; repo: string; issueNumber: number; commentId: number; actor: string;
  idempotencyKey?: string;
  pullRequest?: PullRequestContext;
}): Record<string, unknown> {
  return {
    github_owner: args.owner,
    github_repo: args.repo,
    github_issue_number: args.issueNumber,
    github_comment_id: args.commentId,
    github_actor: args.actor,
    source: 'coinpaybot',
    ...(args.idempotencyKey ? { idempotency_key: args.idempotencyKey } : {}),
    ...(args.pullRequest
      ? {
          github_pull_request_url: args.pullRequest.url,
          github_linked_issues: args.pullRequest.linkedIssues.map((issue) => issue.url),
        }
      : {}),
  };
}

export function normalizeInvoice(cmd: InvoiceCommand, defaultCrypto: string): Required<Pick<InvoiceCommand, 'amount' | 'fiat' | 'crypto'>> & Partial<InvoiceCommand> {
  return { ...cmd, crypto: cmd.crypto ?? defaultCrypto };
}
