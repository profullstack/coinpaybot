/**
 * Renders GitHub comment bodies (PRD §9) and embeds hidden machine-readable
 * markers so the Action can stay stateless (no database in the MVP):
 *
 *  - HANDLED marker: dedupes repeated events by triggering comment id (FR-008).
 *  - REQUEST marker: lets `/coinpay approve` recover the pending invoice's terms
 *    by scanning the thread, instead of a persisted request record.
 */

import type { InvoiceCommand } from './parser.js';

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

export function handledMarker(commentId: number): string {
  return `<!-- coinpay:handled ${commentId} -->`;
}

/** Has any of these existing comment bodies already handled `commentId`? */
export function isHandled(existingBodies: string[], commentId: number): boolean {
  for (const body of existingBodies) {
    HANDLED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HANDLED_RE.exec(body)) !== null) {
      if (Number(m[1]) === commentId) return true;
    }
  }
  return false;
}

export function requestMarker(req: PendingRequest): string {
  return `<!-- coinpay:request ${JSON.stringify(req)} -->`;
}

/** Recover the most recent pending request embedded in the thread, if any. */
export function findPendingRequest(existingBodies: string[]): PendingRequest | null {
  for (let i = existingBodies.length - 1; i >= 0; i--) {
    const m = REQUEST_RE.exec(existingBodies[i] ?? '');
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]) as PendingRequest;
      } catch {
        /* ignore malformed marker */
      }
    }
  }
  return null;
}

function fmtAmount(amount: number, fiat: string): string {
  return `${amount.toFixed(2)} ${fiat}`;
}

export function successComment(args: {
  amount: number; fiat: string; crypto: string; description?: string;
  paymentId: string; payLink: string; actor: string; handledCommentId: number;
}): string {
  return [
    '### CoinPayPortal invoice created',
    '',
    `**Amount:** ${fmtAmount(args.amount, args.fiat)}  `,
    `**Crypto:** ${args.crypto}  `,
    ...(args.description ? [`**Description:** ${args.description}  `] : []),
    `**Payment ID:** \`${args.paymentId}\``,
    '',
    `**Pay here:** ${args.payLink}`,
    '',
    `_Triggered by @${args.actor}_`,
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
    `@${r.requester} requested **${fmtAmount(r.amount, r.fiat)}** in **${r.crypto}** for:`,
    `> ${r.description ?? '(no description)'}`,
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
    `**Crypto:** ${args.crypto}  `,
    `**Status:** Paid / forwarded  `,
    `**Payment ID:** \`${args.paymentId}\``,
    '',
    `This issue has been labeled \`${args.paidLabel}\`.`,
  ].join('\n');
}

export function errorComment(message: string, handledCommentId?: number): string {
  const lines = ['### CoinPayPortal', '', `:warning: ${message}`];
  if (handledCommentId !== undefined) lines.push('', handledMarker(handledCommentId));
  return lines.join('\n');
}

export function helpComment(): string {
  return [
    '### CoinPayPortal commands',
    '',
    '| Command | Description |',
    '| --- | --- |',
    '| `/coinpay invoice <amount> USD --crypto <code> --for "<desc>"` | Create (maintainer) or request (contributor) a payment. |',
    '| `/coinpay approve` | Maintainer: approve the pending request in this thread. |',
    '| `/coinpay status` | Show the current payment status for this thread. |',
    '| `/coinpay cancel` | Maintainer: cancel the pending request in this thread. |',
    '| `/coinpay help` | Show this help. |',
    '',
    'Example: `/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"`',
  ].join('\n');
}

/** Build the invoice metadata forwarded to CoinPayPortal (PRD §12.2). */
export function invoiceMetadata(args: {
  owner: string; repo: string; issueNumber: number; commentId: number; actor: string;
}): Record<string, unknown> {
  return {
    github_owner: args.owner,
    github_repo: args.repo,
    github_issue_number: args.issueNumber,
    github_comment_id: args.commentId,
    github_actor: args.actor,
    source: 'coinpaybot',
  };
}

export function normalizeInvoice(cmd: InvoiceCommand, defaultCrypto: string): Required<Pick<InvoiceCommand, 'amount' | 'fiat' | 'crypto'>> & Partial<InvoiceCommand> {
  return { ...cmd, crypto: cmd.crypto ?? defaultCrypto };
}
