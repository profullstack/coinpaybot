import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { CoinPayClient } from '../src/coinpay.js';
import { resolveConfig } from '../src/config.js';
import { handleComment, type CommentEvent } from '../src/handler.js';
import {
  invoiceReferenceMarker,
  latestInvoiceReference,
  statusMarker,
} from '../src/invoice-status.js';
import { handledMarker } from '../src/render.js';

const id = '3f9c1e00-0000-4000-8000-000000000001';
const ref = {
  invoiceId: id,
  repositoryId: 123,
  threadNumber: 42,
  commentId: 100,
};
const time = '2026-09-20T10:00:00Z';
const event: CommentEvent = {
  ref: { owner: 'acme', repo: 'widgets', issueNumber: 42 },
  repositoryId: 123,
  commentId: 200,
  actor: 'alice',
  actorId: 5,
  actorType: 'User',
  authorAssociation: 'NONE',
  body: '/coinpay status',
  issueUrl: 'https://github.com/acme/widgets/pull/42',
  isPullRequest: true,
};
function fixture() {
  const row = {
    id,
    business_id: 'business',
    currency: 'USD',
    amount: '10.00',
    invoice_number: 'INV-1',
    status: 'sent',
    created_at: time,
    metadata: {
      source_reference: {
        provider: 'github',
        repository: 'acme/widgets',
        thread_number: 42,
        comment_id: 100,
        actor_id: 5,
      },
    },
    notes: 'PRIVATE_SENTINEL',
    clients: { email: 'PRIVATE_SENTINEL' },
    merchant_wallet_address: 'PRIVATE_SENTINEL',
    tx_hash: 'PRIVATE_SENTINEL',
  };
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ success: true, invoice: row })),
  );
  const source = {
    id: 100,
    authorId: 5,
    authorLogin: 'alice',
    authorType: 'User',
    body: 'original',
    createdAt: time,
    issueUrl: 'https://api.github.com/repos/acme/widgets/issues/42',
  };
  const comments = [
    {
      id: 101,
      authorId: 77,
      authorLogin: 'github-actions[bot]',
      authorType: 'Bot',
      trustedAuthor: true,
      createdAt: time,
      body: invoiceReferenceMarker(ref),
    },
  ];
  const github = {
    listComments: vi.fn(),
    listRecentComments: vi.fn(async () => comments),
    getSourceComment: vi.fn(async () => source),
    getPullRequestContext: vi.fn(),
    createComment: vi.fn(),
    addLabels: vi.fn(),
  };
  const config = resolveConfig({
    commands: { status: true },
    githubInvoices: { enabled: true, pdfEnabled: true },
  });
  const coinpay = new CoinPayClient({
    baseUrl: 'https://coinpayportal.com',
    apiKey: 'SECRET_KEY',
    businessId: 'business',
    fetchImpl,
  });
  return { row, comments, source, fetchImpl, github, config, coinpay };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('read-only tracked invoice status', () => {
  it('rejects a real HTTP redirect without forwarding a bearer key', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      response.writeHead(302, { location: '/unexpected-recipient' });
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No local port');
      const client = new CoinPayClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: 'LOCAL_ONLY',
        businessId: 'business',
      });
      await expect(
        client.getInvoiceStatus(ref, 'acme/widgets'),
      ).rejects.toThrow('Invoice status unavailable');
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('uses source creation order even when an old reply lands late', () => {
    const f = fixture();
    f.comments.push({
      ...f.comments[0]!,
      id: 102,
      body: invoiceReferenceMarker({ ...ref, commentId: 200 }),
    });
    f.comments.push({
      ...f.comments[0]!,
      id: 103,
      body: invoiceReferenceMarker(ref),
    });
    expect(latestInvoiceReference(f.comments, 123, 42)?.commentId).toBe(200);
  });
  it.each(['issue', 'missingRepo', 'missingComment', 'noAdapter'])(
    'silently skips unsupported %s context on repeated deliveries',
    async (kind) => {
      const f = fixture();
      const evt = { ...event };
      if (kind === 'issue') evt.isPullRequest = false;
      if (kind === 'missingRepo') evt.repositoryId = undefined;
      if (kind === 'missingComment') evt.commentId = 0;
      const github =
        kind === 'noAdapter'
          ? { ...f.github, listRecentComments: undefined }
          : f.github;
      for (let i = 0; i < 2; i++)
        expect(await handleComment(evt, { ...f, github })).toMatchObject({
          action: 'skipped',
        });
      expect(f.github.createComment).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );
  it('lets an expired cooldown proceed but tolerates a small server clock lead', async () => {
    for (const age of [-10000, 61000]) {
      const f = fixture();
      f.comments.push({
        ...f.comments[0]!,
        id: 102,
        createdAt: new Date(Date.now() - age).toISOString(),
        body: statusMarker(123, 42),
      });
      await handleComment(event, f);
      expect(f.fetchImpl).toHaveBeenCalledTimes(age < 0 ? 0 : 1);
    }
  });
  it.each(['sent', 'overdue', 'paid'])(
    'projects %s without leaking private row or claiming settlement',
    async (status) => {
      const f = fixture();
      f.row.status = status;
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await handleComment(event, f)).toEqual({ action: 'status' });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.fetchImpl).toHaveBeenCalledWith(
        `https://coinpayportal.com/api/invoices/${id}`,
        expect.objectContaining({ method: 'GET', redirect: 'error' }),
      );
      const body = f.github.createComment.mock.calls[0]![1] as string;
      expect(body).toContain('10.00 USD');
      expect(body).toContain(`**Status:** ${status}`);
      expect(body).toContain(`/now/${id}`);
      expect(body).toContain(`/api/invoices/${id}/pdf`);
      expect(body).toContain('Checked at');
      if (status === 'paid')
        expect(body).toContain('does not confirm on-chain settlement');
      expect(body).not.toMatch(/PRIVATE_SENTINEL|SECRET_KEY|Paid \/ forwarded/);
      expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(
        'PRIVATE_SENTINEL',
      );
      expect(f.github.listComments).not.toHaveBeenCalled();
      expect(f.github.addLabels).not.toHaveBeenCalled();
    },
  );
  it.each(['draft', 'cancelled', 'unknown', ''])(
    'does not reveal %s invoices or fall back to an older reference',
    async (status) => {
      const f = fixture();
      f.row.status = status;
      f.comments.unshift({
        ...f.comments[0]!,
        id: 99,
        body: invoiceReferenceMarker({
          ...ref,
          invoiceId: '3f9c1e00-0000-4000-8000-000000000002',
          commentId: 50,
        }),
      });
      await handleComment(event, f);
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.github.createComment.mock.calls[0]![1]).not.toMatch(
        /\/now\/|\/pdf|10.00|PRIVATE_SENTINEL/,
      );
    },
  );
  it.each([
    'business',
    'id',
    'sourceRepo',
    'sourceThread',
    'sourceComment',
    'actor',
    'time',
    'currency',
    'amount',
    'number',
  ])('rejects invalid %s binding or fields', async (field) => {
    const f = fixture();
    switch (field) {
      case 'business':
        f.row.business_id = 'foreign';
        break;
      case 'id':
        f.row.id = '3f9c1e00-0000-4000-8000-000000000002';
        break;
      case 'sourceRepo':
        f.row.metadata.source_reference.repository = 'other/repo';
        break;
      case 'sourceThread':
        f.row.metadata.source_reference.thread_number = 43;
        break;
      case 'sourceComment':
        f.row.metadata.source_reference.comment_id = 200;
        break;
      case 'actor':
        f.row.metadata.source_reference.actor_id = 6;
        break;
      case 'time':
        f.source.createdAt = '2026-09-20T10:05:00Z';
        break;
      case 'currency':
        f.row.currency = 'EUR';
        break;
      case 'amount':
        f.row.amount = '10.001';
        break;
      case 'number':
        f.row.invoice_number = '';
        break;
    }
    expect(await handleComment(event, f)).toMatchObject({
      detail: 'unavailable',
    });
    expect(f.github.createComment.mock.calls[0]![1]).not.toMatch(
      /\/now\/|\/pdf|PRIVATE_SENTINEL/,
    );
  });
  it.each(['thread', 'id', 'authorType', 'deleted', 'date'])(
    'fails closed for an invalid %s source comment',
    async (kind) => {
      const f = fixture();
      if (kind === 'thread')
        f.source.issueUrl =
          'https://api.github.com/repos/acme/widgets/issues/43';
      if (kind === 'id') f.source.id = 200;
      if (kind === 'authorType') f.source.authorType = 'Bot';
      if (kind === 'date') f.source.createdAt = 'invalid';
      if (kind === 'deleted')
        f.github.getSourceComment.mockRejectedValue(
          new Error('PRIVATE_SENTINEL'),
        );
      expect(await handleComment(event, f)).toMatchObject({
        detail: 'unavailable',
      });
    },
  );
  it('ignores human, other-repository and malformed markers, including untracked old links', async () => {
    const f = fixture();
    f.comments[0]!.trustedAuthor = false;
    f.comments.push({
      ...f.comments[0]!,
      trustedAuthor: true,
      id: 102,
      body: invoiceReferenceMarker({ ...ref, repositoryId: 999 }),
    });
    f.comments.push({
      ...f.comments[0]!,
      trustedAuthor: true,
      id: 103,
      body:
        '<!-- coinpay:invoice:v1 e30 --> https://coinpayportal.com/now/' + id,
    });
    await handleComment(event, f);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('does not let a newer human copy override the newest bot reference', () => {
    const f = fixture();
    f.comments.push({
      ...f.comments[0]!,
      id: 110,
      trustedAuthor: false,
      body: invoiceReferenceMarker({ ...ref, commentId: 999 }),
    });
    expect(latestInvoiceReference(f.comments, 123, 42)).toEqual(ref);
  });
  it('honors disabled config, human filtering and already-handled events before an invoice read', async () => {
    for (const mode of ['command', 'global', 'bot', 'duplicate']) {
      const f = fixture();
      const evt = { ...event };
      if (mode === 'command') f.config.commands.status = false;
      if (mode === 'global') f.config.enabled = false;
      if (mode === 'bot') evt.actorType = 'Bot';
      if (mode === 'duplicate')
        f.comments[0]!.body += handledMarker(event.commentId);
      await handleComment(evt, f);
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.github.createComment).not.toHaveBeenCalled();
    }
  });
  it('uses server timestamps for a best-effort cooldown without another reply or read', async () => {
    const f = fixture();
    f.comments.push({
      ...f.comments[0]!,
      id: 102,
      createdAt: new Date().toISOString(),
      body: statusMarker(123, 42),
    });
    expect(await handleComment(event, f)).toMatchObject({
      detail: 'status_cooldown',
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.github.createComment).not.toHaveBeenCalled();
  });
  it('does not let a human status marker suppress reads and honors PDF off', async () => {
    const f = fixture();
    f.config.githubInvoices.pdfEnabled = false;
    f.comments.push({
      ...f.comments[0]!,
      id: 102,
      trustedAuthor: false,
      createdAt: new Date().toISOString(),
      body: statusMarker(123, 42),
    });
    await handleComment(event, f);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.github.createComment.mock.calls[0]![1]).not.toContain('/pdf');
  });
  it.each([401, 403, 404, 410, 429, 500, 503])(
    'does not expose API error %s bodies',
    async (status) => {
      const f = fixture();
      f.fetchImpl.mockResolvedValue(
        new Response('PRIVATE_SENTINEL', { status }),
      );
      await handleComment(event, f);
      expect(f.github.createComment.mock.calls[0]![1]).not.toMatch(
        /PRIVATE_SENTINEL|\/now\//,
      );
    },
  );
  it.each(['malformed', 'oversize', 'network'])(
    'handles %s responses with fixed errors',
    async (kind) => {
      const f = fixture();
      if (kind === 'malformed')
        f.fetchImpl.mockResolvedValue(new Response('{PRIVATE_SENTINEL'));
      if (kind === 'oversize')
        f.fetchImpl.mockResolvedValue(new Response('x'.repeat(65537)));
      if (kind === 'network')
        f.fetchImpl.mockRejectedValue(new Error('PRIVATE_SENTINEL'));
      await handleComment(event, f);
      expect(f.github.createComment.mock.calls[0]![1]).not.toContain(
        'PRIVATE_SENTINEL',
      );
    },
  );
  it.each(['headers', 'body'])(
    'times out stalled %s and cleans the timer',
    async (phase) => {
      vi.useFakeTimers();
      const f = fixture();
      if (phase === 'headers')
        f.fetchImpl.mockImplementation(() => new Promise(() => {}));
      else
        f.fetchImpl.mockResolvedValue(
          new Response(new ReadableStream({ start() {} })),
        );
      const result = handleComment(event, f);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await result).toMatchObject({ detail: 'unavailable' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('never retries ambiguous GitHub writes', async () => {
    const f = fixture();
    f.github.createComment.mockRejectedValue(new Error('GitHub failed'));
    await expect(handleComment(event, f)).rejects.toThrow('GitHub failed');
    expect(f.github.createComment).toHaveBeenCalledOnce();
  });
  it('cancels the stream reader when the transport ignores timeout abort', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const cancel = vi.fn();
    f.fetchImpl.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const result = handleComment(event, f);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ detail: 'unavailable' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('discards a response arriving after timeout without starting a body read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.fetchImpl.mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const result = handleComment(event, f);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ detail: 'unavailable' });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const reader = vi.spyOn(body, 'getReader');
    resolve(new Response(body));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(reader).not.toHaveBeenCalled();
    expect(f.github.createComment).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
