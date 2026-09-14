/**
 * End-to-end flow for `/coinpay create @payer <amount> "<description>"` with an
 * in-memory fake GitHub and a STATEFUL fake CoinPayPortal that implements the
 * verified idempotent create/publish contract. Statefulness is the point:
 * replay across "process restarts" (fresh handler invocations), publish
 * failure retry, and closed-invoice replays are exercised against it.
 */
import { describe, it, expect } from 'vitest';
import { CoinPayClient } from '../src/coinpay.js';
import type {
  GitHubClient,
  IssueRef,
  PullRequestContext,
  ThreadComment,
} from '../src/github.js';
import { githubInvoiceIdempotencyKey, handleComment } from '../src/handler.js';
import type { CommentEvent, HandlerDeps } from '../src/handler.js';
import { resolveConfig } from '../src/config.js';

class FakeGitHub implements GitHubClient {
  comments: string[] = [];
  existingComments: ThreadComment[] = [];
  labels: string[] = [];
  pullRequest: PullRequestContext | null = null;
  async listComments(_ref: IssueRef): Promise<ThreadComment[]> {
    return [
      ...this.existingComments,
      ...this.comments.map((body) => ({
        body,
        authorLogin: 'github-actions[bot]',
        authorType: 'Bot',
        trustedAuthor: true,
      })),
    ];
  }
  async getPullRequestContext(_ref: IssueRef): Promise<PullRequestContext | null> {
    return this.pullRequest;
  }
  async createComment(_ref: IssueRef, body: string): Promise<void> {
    this.comments.push(body);
  }
  async addLabels(_ref: IssueRef, labels: string[]): Promise<void> {
    this.labels.push(...labels);
  }
}

const BUSINESS_ID = 'biz_123';
const BASE = 'https://coinpayportal.com';

interface PortalCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Minimal in-memory model of the portal's idempotent invoice contract:
 * per-key replay, terms-hash conflict, per-repo cap, and draft→sent publish.
 */
class FakePortal {
  calls: PortalCall[] = [];
  invoices = new Map<string, Record<string, unknown>>();
  keyIndex = new Map<string, { hash: string; invoiceId: string }>();
  invoiceSeq = 0;
  hourlyUsed = 0;
  /** Failure injection for the next publish call. */
  failNextPublish: 'network' | 'in_progress' | null = null;
  /** Hook that runs after publish succeeds — used to simulate races. */
  onPublished: (() => void) | null = null;

  readonly fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const call: PortalCall = {
      url: u,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    this.calls.push(call);
    const respond = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

    if (u === `${BASE}/api/invoices` && call.method === 'POST') {
      const key = call.headers['Idempotency-Key'];
      if (!key) return respond(400, { success: false, error: 'Idempotency-Key required for this test double' });
      const body = call.body as Record<string, unknown>;
      const hash = JSON.stringify(body);
      const previous = this.keyIndex.get(key);
      if (previous) {
        if (previous.hash !== hash) {
          return respond(409, { success: false, error: 'This key was already used with different invoice terms', code: 'IDEMPOTENCY_CONFLICT' });
        }
        return respond(200, {
          success: true,
          invoice: this.invoices.get(previous.invoiceId),
          idempotentReplay: true,
        });
      }
      const cap = body['source_rate_limit'] as number;
      if (this.hourlyUsed >= cap) {
        return respond(429, { success: false, error: 'Repository invoice rate limit reached; retry later with the same key', code: 'SOURCE_RATE_LIMIT' });
      }
      this.hourlyUsed += 1;
      this.invoiceSeq += 1;
      const id = `3f9c1e00-0000-4000-8000-${String(this.invoiceSeq).padStart(12, '0')}`;
      const invoice = {
        id,
        business_id: BUSINESS_ID,
        client_id: null,
        invoice_number: `INV-${String(this.invoiceSeq).padStart(3, '0')}`,
        status: 'draft',
        currency: body['currency'],
        amount: String(body['amount']),
        crypto_currency: body['crypto_currency'],
        fee_rate: '0.01',
        notes: body['notes'],
        metadata: { source_reference: body['source_reference'] },
        businesses: { id: BUSINESS_ID, name: 'Acme LLC' },
      };
      this.invoices.set(id, invoice);
      this.keyIndex.set(key, { hash, invoiceId: id });
      return respond(201, { success: true, invoice, idempotentReplay: false });
    }

    const publish = /\/api\/invoices\/([^/]+)\/publish$/.exec(u);
    if (publish && call.method === 'POST') {
      if (this.failNextPublish === 'network') {
        this.failNextPublish = null;
        throw new Error('socket hang up');
      }
      if (this.failNextPublish === 'in_progress') {
        this.failNextPublish = null;
        return respond(409, { success: false, error: 'Invoice payment is still being created; retry shortly', code: 'PAYMENT_CREATION_IN_PROGRESS' });
      }
      const invoice = this.invoices.get(publish[1]!);
      if (!invoice) return respond(404, { success: false, error: 'Invoice not found' });
      if (invoice['status'] === 'draft') {
        // The real activation passes the stored code to createPayment's
        // case-sensitive Blockchain enum. Do not hide that contract here.
        if (invoice['crypto_currency'] !== 'USDC_POL') {
          return respond(500, {success: false, error: 'Invalid blockchain type'});
        }
        invoice['status'] = 'sent';
        invoice['payment_address'] = '0xpaymentaddr';
        invoice['fee_amount'] = Number(invoice['amount']) * 0.01;
        this.onPublished?.();
        return respond(200, {
          success: true, invoice, paymentLink: `${BASE}/now/${invoice['id']}`,
          emailAttempted: false, idempotentReplay: false,
        });
      }
      if (invoice['status'] === 'sent') {
        return respond(200, {
          success: true, invoice, paymentLink: `${BASE}/now/${invoice['id']}`,
          emailAttempted: false, idempotentReplay: true,
        });
      }
      return respond(400, { success: false, error: `Cannot publish invoice with status: ${invoice['status']}`, code: 'INVOICE_NOT_PUBLISHABLE' });
    }

    return respond(404, { success: false, error: `Unexpected endpoint: ${call.method} ${u}` });
  }) as unknown as typeof fetch;
}

const REF: IssueRef = { owner: 'acme', repo: 'widgets', issueNumber: 42 };

function event(overrides: Partial<CommentEvent>): CommentEvent {
  return {
    ref: REF,
    repositoryId: 1234,
    commentId: 9001,
    body: '/coinpay create @hubber 25 "Fix the settlement race"',
    actor: 'octocat',
    actorId: 555,
    actorType: 'User',
    authorAssociation: 'NONE',
    issueUrl: 'https://github.com/acme/widgets/issues/42',
    isPullRequest: false,
    ...overrides,
  };
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig({ githubInvoices: { enabled: true, ...overrides } } as never);
}

function deps(gh: FakeGitHub, portal: FakePortal, config = enabledConfig()): HandlerDeps {
  return {
    coinpay: new CoinPayClient({
      baseUrl: BASE,
      apiKey: 'cp_live_test',
      businessId: BUSINESS_ID,
      fetchImpl: portal.fetchImpl,
    }),
    github: gh,
    config,
  };
}

describe('publish-invoice happy path', () => {
  it('adds an opted-in PDF link without making any extra API call', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const res = await handleComment(event({}), deps(gh, portal, enabledConfig({ pdfEnabled: true })));
    expect(res.action).toBe('invoice_published');
    expect(gh.comments[0]).toContain(`${BASE}/api/invoices/${res.invoiceId}/pdf`);
    expect(gh.comments[0]).toContain(`${BASE}/now/${res.invoiceId}`);
    expect(gh.comments[0]).toContain('Not a receipt');
    expect(portal.calls).toHaveLength(2);
    expect(portal.invoiceSeq).toBe(1);
    await handleComment(event({}), deps(gh, portal, enabledConfig({ pdfEnabled: true })));
    expect(portal.invoiceSeq).toBe(1);
    expect(gh.comments).toHaveLength(1);
  });

  it('keeps the checkout reply when optional PDF derivation is unavailable', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const dependencies = deps(gh, portal, enabledConfig({ pdfEnabled: true }));
    dependencies.coinpay.invoicePdfLink = () => null;
    const res = await handleComment(event({}), dependencies);
    expect(res.action).toBe('invoice_published');
    expect(gh.comments[0]).toContain(`${BASE}/now/${res.invoiceId}`);
    expect(gh.comments[0]).not.toContain('PDF snapshot');
    expect(portal.invoiceSeq).toBe(1);
    expect(portal.calls).toHaveLength(2);
  });

  it('does not generate PDF links or requests during dry run', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const res = await handleComment(event({ body: '/coinpay create @hubber 25 "Example" --dry-run' }),
      deps(gh, portal, enabledConfig({ pdfEnabled: true })));
    expect(res.action).toBe('dry_run');
    expect(portal.calls).toHaveLength(0);
    expect(gh.comments[0]).not.toContain('/pdf');
  });
  it('creates a draft, publishes it, and posts the verified reply', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(event({}), deps(gh, portal));

    expect(res.action).toBe('invoice_published');
    expect(res.invoiceId).toBe('3f9c1e00-0000-4000-8000-000000000001');
    expect(gh.comments).toHaveLength(1);
    const comment = gh.comments[0]!;
    expect(comment).toContain('@hubber');
    expect(comment).toContain('`INV-001`');
    expect(comment).toContain('25.00 USD');
    expect(comment).toContain('Fix the settlement race');
    expect(comment).toContain('[acme/widgets#42](https://github.com/acme/widgets/issues/42)');
    expect(comment).toContain('https://coinpayportal.com/now/3f9c1e00-0000-4000-8000-000000000001');
    expect(comment).toContain('1% (0.25 USD)');
    expect(comment).not.toContain('/pdf');
    // Honesty about issuer and payer identity, in the public reply itself.
    expect(comment).toContain('configured CoinPayPortal business');
    expect(comment).toContain('not a linked CoinPay client');
    expect(comment).toContain('<!-- coinpay:handled 9001 -->');
    expect(gh.labels).toEqual(['coinpay:pending']);
  });

  it('only ever calls the create and publish endpoints — never paid/send/delete', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    await handleComment(event({}), deps(gh, portal));

    expect(portal.calls).toHaveLength(2);
    expect(portal.calls.map((c) => c.url)).toEqual([
      `${BASE}/api/invoices`,
      `${BASE}/api/invoices/3f9c1e00-0000-4000-8000-000000000001/publish`,
    ]);
  });

  it('sends the full source audit reference, stable notes, and the configured cap', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    await handleComment(
      event({ isPullRequest: true }),
      deps(gh, portal, enabledConfig({ repositoryHourlyCap: 7 })),
    );

    const body = portal.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      business_id: BUSINESS_ID,
      amount: 25,
      currency: 'USD',
      crypto_currency: 'USDC_POL',
      notes: 'Fix the settlement race\n\nhttps://github.com/acme/widgets/pull/42#issuecomment-9001',
      source_reference: {
        provider: 'github',
        repository: 'acme/widgets',
        thread_number: 42,
        comment_id: 9001,
        actor_id: 555,
        actor_login: 'octocat',
        payer_login: 'hubber',
      },
      source_rate_limit: 7,
    });
    // Nothing user-controlled beyond the validated fields — never a wallet,
    // client, or email.
    expect(Object.keys(body).sort()).toEqual([
      'amount', 'business_id', 'crypto_currency', 'currency', 'notes',
      'source_rate_limit', 'source_reference',
    ]);
  });

  it('is open to non-collaborator humans — no role gate on the new flow', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(
      event({ authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }),
      deps(gh, portal),
    );

    expect(res.action).toBe('invoice_published');
  });
});

describe('gates before any CoinPay call', () => {
  it('explains the feature flag when disabled (default) and calls nothing', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(event({}), deps(gh, portal, resolveConfig()));

    expect(res).toMatchObject({ action: 'noop_disabled', detail: 'github_invoices_disabled' });
    expect(portal.calls).toHaveLength(0);
    expect(gh.comments[0]).toContain('githubInvoices.enabled: true');
    expect(gh.comments[0]).toContain('migration');
  });

  it('still explains the flag for a --dry-run when disabled', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(
      event({ body: '/coinpay create @hubber 25 "x" --dry-run' }),
      deps(gh, portal, resolveConfig()),
    );

    expect(res.action).toBe('noop_disabled');
    expect(portal.calls).toHaveLength(0);
  });

  it('obeys the global kill switch before anything else', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(
      event({}),
      deps(gh, portal, resolveConfig({ enabled: false, githubInvoices: { enabled: true } } as never)),
    );

    expect(res.action).toBe('noop_disabled');
    expect(portal.calls).toHaveLength(0);
    expect(gh.comments).toHaveLength(0);
  });

  it('silently ignores bot-authored commands, including their parse errors', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const valid = await handleComment(
      event({ actor: 'dependabot[bot]', actorType: 'Bot' }),
      deps(gh, portal),
    );
    const invalid = await handleComment(
      event({ actorType: 'Bot', body: '/coinpay create @hubber nonsense "x"' }),
      deps(gh, portal),
    );

    expect(valid).toMatchObject({ action: 'skipped', detail: 'non_human_commenter' });
    expect(invalid).toMatchObject({ action: 'skipped', detail: 'non_human_commenter' });
    expect(portal.calls).toHaveLength(0);
    expect(gh.comments).toHaveLength(0);
  });

  it('fails closed without an immutable actor id', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(event({ actorId: undefined }), deps(gh, portal));

    expect(res).toMatchObject({ action: 'error', detail: 'missing_actor_identity' });
    expect(portal.calls).toHaveLength(0);
    expect(gh.comments[0]).toContain('no invoice was created');
  });

  it('enforces the configured per-invoice maximum', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(
      event({ body: '/coinpay create @hubber 1000.01 "big"' }),
      deps(gh, portal),
    );

    expect(res).toMatchObject({ action: 'error', detail: 'amount_over_limit' });
    expect(portal.calls).toHaveLength(0);
    expect(gh.comments[0]).toContain('1000.00 USD');
  });
});

describe('dry run', () => {
  it('previews without CoinPay calls, labels, or a payer notification', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(
      event({ body: '/coinpay create @hubber $25 USD "Fix the settlement race" --dry-run' }),
      deps(gh, portal),
    );

    expect(res.action).toBe('dry_run');
    expect(portal.calls).toHaveLength(0);
    expect(gh.labels).toHaveLength(0);
    const comment = gh.comments[0]!;
    expect(comment).toContain('no invoice was created');
    // The mention is rendered inside a code span, which GitHub does not
    // notify on; the live-ping form `@hubber ` must not appear bare.
    expect(comment).toContain('`@hubber`');
    expect(comment).not.toMatch(/(^|[^`])@hubber( |$)/m);
    expect(comment).not.toContain('/now/');
    expect(comment).toContain('github:repository:1234:comment:9001');
    expect(comment).toContain('<!-- coinpay:handled 9001 -->');
  });
});

describe('idempotency and retries', () => {
  it('derives the key from immutable repository and comment IDs, surviving restarts and renames', () => {
    const key = githubInvoiceIdempotencyKey(1234, 9001);
    expect(key).toBe('github:repository:1234:comment:9001');
    expect(githubInvoiceIdempotencyKey(1234, 9001)).toBe(key);
    expect(githubInvoiceIdempotencyKey(1234, 9002)).not.toBe(key);
    expect(githubInvoiceIdempotencyKey(5678, 9001)).not.toBe(key);
  });

  it('a repository rename cannot create a second invoice for the same source comment', async () => {
    const portal = new FakePortal();
    const first = await handleComment(event({}), deps(new FakeGitHub(), portal));
    expect(first.action).toBe('invoice_published');
    const second = await handleComment(event({ref: {...REF, repo: 'renamed'}}), deps(new FakeGitHub(), portal));
    expect(second).toMatchObject({action: 'error', detail: 'IDEMPOTENCY_CONFLICT'});
    expect(portal.calls.filter((call) => call.url.endsWith('/api/invoices'))).toHaveLength(2);
  });

  it('skips a redelivered comment that was already answered', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const d = deps(gh, portal);

    await handleComment(event({}), d);
    const replay = await handleComment(event({}), d);

    expect(replay.action).toBe('noop_duplicate');
    expect(gh.comments).toHaveLength(1);
    expect(portal.calls).toHaveLength(2); // no additional API traffic
  });

  it('retries after a publish failure by reusing the same draft, never a link before publish', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    portal.failNextPublish = 'network';

    // First delivery: draft created, publish dies. Error reply, no link, no
    // handled marker (so the event may be retried), error label.
    const first = await handleComment(event({}), deps(gh, portal));
    expect(first).toMatchObject({ action: 'error', detail: 'NETWORK' });
    expect(gh.comments[0]).not.toContain('/now/');
    expect(gh.comments[0]).not.toContain('coinpay:handled');
    expect(gh.labels).toContain('coinpay:error');

    // Second delivery (fresh process): create replays the SAME invoice via the
    // derived key, publish succeeds, and the link is finally posted.
    const second = await handleComment(event({}), deps(gh, portal));
    expect(second.action).toBe('invoice_published');
    expect(second.invoiceId).toBe(first.invoiceId ?? second.invoiceId);
    expect(portal.invoices.size).toBe(1);
    const creates = portal.calls.filter((c) => c.url === `${BASE}/api/invoices`);
    expect(creates).toHaveLength(2);
    expect(creates[0]!.headers['Idempotency-Key']).toBe(creates[1]!.headers['Idempotency-Key']);
    expect(gh.comments[1]).toContain('/now/3f9c1e00-0000-4000-8000-000000000001');
  });

  it('reports a 409 publish-in-progress as retryable without a payment link', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    portal.failNextPublish = 'in_progress';

    const res = await handleComment(event({}), deps(gh, portal));

    expect(res).toMatchObject({ action: 'error', detail: 'PUBLISH_RETRY' });
    expect(gh.comments[0]).toContain('re-run this same GitHub Actions run, not post a new command comment');
    expect(gh.comments[0]).not.toContain('/now/');
  });

  it('never revives a replayed invoice that has since been paid', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const d = deps(gh, portal);
    portal.failNextPublish = 'network';
    await handleComment(event({}), d); // draft exists, publish failed
    portal.invoices.get('3f9c1e00-0000-4000-8000-000000000001')!['status'] = 'paid';

    const res = await handleComment(event({}), d);

    expect(res).toMatchObject({ action: 'invoice_already_closed', detail: 'paid' });
    const publishes = portal.calls.filter((c) => c.url.endsWith('/publish'));
    expect(publishes).toHaveLength(1); // only the first, failed attempt
    expect(gh.comments[1]).toContain('already created from this exact comment');
    expect(gh.comments[1]).toContain('`paid`');
    expect(gh.comments[1]).not.toContain('/now/');
  });

  it('rejects changed terms for the same comment identity with a safe message', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const d = deps(gh, portal);
    portal.failNextPublish = 'network';
    await handleComment(event({}), d);

    // Same comment id, different amount → same derived key, different terms.
    const res = await handleComment(
      event({ body: '/coinpay create @hubber 26 "Fix the settlement race"' }),
      d,
    );

    expect(res).toMatchObject({ action: 'error', detail: 'IDEMPOTENCY_CONFLICT' });
    expect(portal.invoices.size).toBe(1);
    expect(gh.comments[1]).toContain('different terms');
    expect(gh.comments[1]).not.toContain('IDEMPOTENCY_CONFLICT'); // no raw codes
  });

  it('translates the repository hourly cap into a safe retry message', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    portal.hourlyUsed = 20;

    const res = await handleComment(event({}), deps(gh, portal));

    expect(res).toMatchObject({ action: 'error', detail: 'RATE_LIMIT' });
    expect(gh.comments[0]).toContain('hourly invoice cap');
    expect(gh.comments[0]).not.toContain('/now/');
  });

  it('reports the missing-migration 503 as temporary unavailability', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const failing = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: 'Invoice idempotency is unavailable; retry later', code: 'IDEMPOTENCY_UNAVAILABLE' }),
    })) as unknown as typeof fetch;

    const res = await handleComment(event({}), {
      ...deps(gh, portal),
      coinpay: new CoinPayClient({ baseUrl: BASE, apiKey: 'k', businessId: BUSINESS_ID, fetchImpl: failing }),
    });

    expect(res).toMatchObject({ action: 'error', detail: 'UNAVAILABLE' });
    expect(gh.comments[0]).toContain('re-run this same GitHub Actions run, not post a new command comment');
  });

  it('explains a terminal validation failure without echoing the response or recommending blind retries', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    const failing = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'private details [pay here](https://evil.example)' }),
    })) as unknown as typeof fetch;
    const res = await handleComment(event({}), {
      ...deps(gh, portal),
      coinpay: new CoinPayClient({ baseUrl: BASE, apiKey: 'k', businessId: BUSINESS_ID, fetchImpl: failing }),
    });
    expect(res).toMatchObject({ action: 'error', detail: 'BAD_REQUEST' });
    expect(gh.comments[0]).toContain('check the command, business settings, and existing invoice');
    expect(gh.comments[0]).not.toContain('re-run this same GitHub Actions run');
    expect(gh.comments[0]).not.toContain('private details');
    expect(gh.comments[0]).not.toContain('evil.example');
    expect(gh.comments[0]).not.toContain('/now/');
  });

  it('re-checks the thread after publish and yields to a concurrent reply', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    // While we were publishing, another delivery answered the same comment.
    portal.onPublished = () => {
      gh.existingComments.push({
        body: 'done <!-- coinpay:handled 9001 -->',
        authorLogin: 'github-actions[bot]',
        authorType: 'Bot',
        trustedAuthor: true,
      });
    };

    const res = await handleComment(event({}), deps(gh, portal));

    expect(res.action).toBe('noop_duplicate');
    expect(gh.comments).toHaveLength(0); // no duplicate reply posted
    expect(portal.invoices.size).toBe(1); // and still exactly one invoice
  });

  it('ignores a forged handled marker from an untrusted author', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    gh.existingComments.push({
      body: '<!-- coinpay:handled 9001 -->',
      authorLogin: 'attacker',
      authorType: 'User',
      trustedAuthor: false,
    });

    const res = await handleComment(event({}), deps(gh, portal));

    expect(res.action).toBe('invoice_published');
  });
});

describe('rendering safety', () => {
  it('neutralizes markers and markdown smuggled through the description', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();

    const res = await handleComment(
      event({
        body: '/coinpay create @hubber 25 "pay <!-- coinpay:handled 9002 --> [now](https://evil.example)"',
      }),
      deps(gh, portal),
    );

    expect(res.action).toBe('invoice_published');
    const comment = gh.comments[0]!;
    expect(comment).not.toContain('<!-- coinpay:handled 9002 -->');
    expect(comment).toContain('&lt;!-- coinpay:handled 9002 --&gt;');
    const descriptionLine = comment
      .split('\n')
      .find((line) => line.startsWith('**Description:**'));
    // The whole description is one inert code span — links stay text.
    expect(descriptionLine).toMatch(/^\*\*Description:\*\* (`+) .+ \1 {2}$/);
    expect(descriptionLine).toContain('[now](https://evil.example)');
  });

  it('keeps the numeric-first legacy create flow exactly as before', async () => {
    const gh = new FakeGitHub();
    const portal = new FakePortal();
    gh.pullRequest = {
      number: 42,
      title: 'Fix checkout',
      url: 'https://github.com/acme/widgets/pull/42',
      author: 'octocat',
      linkedIssues: [],
    };

    // Legacy grammar on a PR: still requires a maintainer + wallet, still uses
    // the payments API — and never touches the invoice endpoints.
    const res = await handleComment(
      event({
        isPullRequest: true,
        authorAssociation: 'OWNER',
        body: '/coinpay create $10 USD --wallet 0xabc',
      }),
      deps(gh, portal),
    );

    expect(res.action).toBe('error'); // FakePortal serves no payments API
    expect(portal.calls.map((c) => c.url)).toEqual([`${BASE}/api/payments/create`]);
  });
});
