import type { ThreadComment } from './github.js';

export const INVOICE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface InvoiceReference {
  invoiceId: string;
  repositoryId: number;
  threadNumber: number;
  commentId: number;
}
export interface InvoiceStatus extends InvoiceReference {
  invoiceNumber: string;
  status: 'sent' | 'overdue' | 'paid';
  currency: 'USD';
  amount: number;
  actorId: number;
  createdAt: string;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function invoiceReferenceMarker(ref: InvoiceReference): string {
  return `<!-- coinpay:invoice:v1 ${Buffer.from(JSON.stringify(ref)).toString('base64url')} -->`;
}

export function latestInvoiceReference(
  comments: ThreadComment[],
  repositoryId: number,
  threadNumber: number,
): InvoiceReference | null {
  let newest: InvoiceReference | null = null;
  for (const comment of [...comments].sort(
    (a, b) => (b.id ?? 0) - (a.id ?? 0),
  )) {
    if (
      !comment.trustedAuthor ||
      !positiveId(comment.id) ||
      !positiveId(comment.authorId)
    )
      continue;
    const encoded = /<!-- coinpay:invoice:v1 ([A-Za-z0-9_-]{1,1024}) -->/.exec(
      comment.body,
    )?.[1];
    if (!encoded) continue;
    try {
      const value = record(
        JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      );
      if (
        typeof value.invoiceId === 'string' &&
        INVOICE_UUID.test(value.invoiceId) &&
        value.repositoryId === repositoryId &&
        value.threadNumber === threadNumber &&
        positiveId(value.commentId)
      ) {
        if (!newest || value.commentId > newest.commentId) {
          newest = {
            invoiceId: value.invoiceId,
            repositoryId,
            threadNumber,
            commentId: value.commentId,
          };
        }
      }
    } catch {
      /* Ignore invalid markers, never accept arbitrary links. */
    }
  }
  return newest;
}

export function statusMarker(
  repositoryId: number,
  threadNumber: number,
): string {
  return `<!-- coinpay:status:v1 ${repositoryId}:${threadNumber} -->`;
}

export function statusCoolingDown(
  comments: ThreadComment[],
  repositoryId: number,
  threadNumber: number,
  now: number,
): boolean {
  return comments.some((c) => {
    const created = Date.parse(c.createdAt ?? '');
    return (
      c.trustedAuthor &&
      positiveId(c.authorId) &&
      positiveId(c.id) &&
      c.body.includes(statusMarker(repositoryId, threadNumber)) &&
      Number.isFinite(created) &&
      created <= now + 60000 &&
      now - created < 60000
    );
  });
}
