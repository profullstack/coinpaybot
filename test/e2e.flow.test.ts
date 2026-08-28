/**
 * End-to-end command flow with in-memory fakes for GitHub and a mocked
 * CoinPayPortal transport. Exercises parser → permissions → adapter →
 * comment/label posting exactly as the Action would at runtime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CoinPayClient } from '../src/coinpay.js';
import type {
  GitHubClient,
  IssueRef,
  PullRequestContext,
  ThreadComment,
} from '../src/github.js';
import { handleComment } from '../src/handler.js';
import type { CommentEvent } from '../src/handler.js';
import { resolveConfig } from '../src/config.js';
import { pullRequestSummary } from '../src/render.js';

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

function paymentOk(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 201,
    json: async () => ({
      success: true,
      payment: { id: 'pay-uuid-1', status: 'pending', amount_usd: '250', amount_crypto: '250.00' },
    }),
    // echo not needed
    _init: init,
  })) as unknown as typeof fetch;
}

function paymentNoWallet(): typeof fetch {
  return (async () => ({
    ok: false,
    status: 400,
    json: async () => ({ success: false, error: 'No USDC_POL wallet configured for this business.' }),
  })) as unknown as typeof fetch;
}

function capturedPayments() {
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      init,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        payment: { id: 'pay-pr-1', status: 'pending', amount_usd: '10' },
      }),
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const REF: IssueRef = { owner: 'acme', repo: 'widgets', issueNumber: 42 };
const PR_CONTEXT: PullRequestContext = {
  number: 42,
  title: 'Fix duplicate settlement records',
  url: 'https://github.com/acme/widgets/pull/42',
  author: 'octocat',
  linkedIssues: [
    {
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      title: 'Settlement can be recorded twice',
      url: 'https://github.com/acme/widgets/issues/7',
    },
  ],
};

function event(overrides: Partial<CommentEvent>): CommentEvent {
  return {
    ref: REF,
    commentId: 1001,
    body: '',
    actor: 'octocat',
    authorAssociation: 'OWNER',
    issueUrl: 'https://github.com/acme/widgets/issues/42',
    isPullRequest: false,
    ...overrides,
  };
}

describe('maintainer creates an invoice directly', () => {
  let gh: FakeGitHub;
  beforeEach(() => (gh = new FakeGitHub()));

  it('creates a payment and posts a link + pending label', async () => {
    const coinpay = new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() });
    const res = await handleComment(
      event({ authorAssociation: 'MEMBER', body: '/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"' }),
      { coinpay, github: gh, config: resolveConfig() },
    );

    expect(res.action).toBe('invoice_created');
    expect(res.paymentId).toBe('pay-uuid-1');
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain('CoinPayPortal invoice created');
    expect(gh.comments[0]).toContain('https://coinpayportal.com/pay/pay-uuid-1');
    expect(gh.comments[0]).toContain('250.00 USD');
    expect(gh.labels).toContain('coinpay:pending');
  });

  it('keeps separate legacy invoice comments as separate payments', async () => {
    const transport = capturedPayments();
    const deps = {
      coinpay: new CoinPayClient({
        baseUrl: 'https://coinpayportal.com',
        apiKey: 'k',
        businessId: 'b',
        fetchImpl: transport.fetchImpl,
      }),
      github: gh,
      config: resolveConfig(),
    };

    expect((await handleComment(
      event({ commentId: 1101, body: '/coinpay invoice 10 USD' }),
      deps,
    )).action).toBe('invoice_created');
    expect((await handleComment(
      event({ commentId: 1102, body: '/coinpay invoice 10 USD' }),
      deps,
    )).action).toBe('invoice_created');

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]!.body.idempotency_key).not.toBe(
      transport.calls[1]!.body.idempotency_key,
    );
  });
});

describe('contributor request then maintainer approval', () => {
  it('parks a pending request, then approval creates the payment from the thread marker', async () => {
    const gh = new FakeGitHub();
    const config = resolveConfig();

    // 1) Contributor requests — no payment yet, just a pending marker + label.
    const requestRes = await handleComment(
      event({ commentId: 2001, actor: 'contrib', authorAssociation: 'CONTRIBUTOR', body: '/coinpay invoice 250 USD --crypto usdc_pol --for "PR #42"' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() }), github: gh, config },
    );
    expect(requestRes.action).toBe('request_pending');
    expect(gh.labels).toContain('coinpay:requested');
    expect(gh.comments[0]).toContain('pending approval');

    // 2) Maintainer approves — bot recovers the terms from the marker and pays.
    const approveRes = await handleComment(
      event({ commentId: 2002, actor: 'maint', authorAssociation: 'OWNER', body: '/coinpay approve' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() }), github: gh, config },
    );
    expect(approveRes.action).toBe('invoice_created');
    expect(gh.labels).toContain('coinpay:approved');
    expect(gh.labels).toContain('coinpay:pending');
    const created = gh.comments.find((c) => c.includes('invoice created'));
    expect(created).toContain('https://coinpayportal.com/pay/pay-uuid-1');
    // The paid invoice should credit the original requester, not the approver.
    expect(created).toContain('_Triggered by @contrib_');
  });

  it('refuses approval from a non-maintainer', async () => {
    const gh = new FakeGitHub();
    gh.comments.push('<!-- coinpay:request {"amount":10,"fiat":"USD","crypto":"usdc_pol","requester":"x","commentId":1} -->');
    const res = await handleComment(
      event({ commentId: 3001, actor: 'rando', authorAssociation: 'NONE', body: '/coinpay approve' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() }), github: gh, config: resolveConfig() },
    );
    expect(res.action).toBe('error');
    expect(res.detail).toBe('unauthorized_approve');
  });
});

describe('safety and edge behavior', () => {
  it('is idempotent: a comment already handled is a no-op', async () => {
    const gh = new FakeGitHub();
    gh.comments.push('previous bot reply <!-- coinpay:handled 5005 -->');
    const res = await handleComment(
      event({ commentId: 5005, body: '/coinpay invoice 250 USD' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() }), github: gh, config: resolveConfig() },
    );
    expect(res.action).toBe('noop_duplicate');
    expect(gh.comments).toHaveLength(1); // nothing new posted
  });

  it('does not post duplicate help for a redelivered comment event', async () => {
    const gh = new FakeGitHub();
    const coinpay = new CoinPayClient({
      baseUrl: 'https://coinpayportal.com',
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: paymentOk(),
    });
    const evt = event({ commentId: 7010, body: '/coinpay help' });

    expect(
      await handleComment(evt, { coinpay, github: gh, config: resolveConfig() }),
    ).toMatchObject({ action: 'help' });
    expect(
      await handleComment(evt, { coinpay, github: gh, config: resolveConfig() }),
    ).toMatchObject({ action: 'noop_duplicate' });
    expect(gh.comments).toHaveLength(1);
  });

  it('surfaces the no-wallet blocker as a friendly comment + error label', async () => {
    const gh = new FakeGitHub();
    const res = await handleComment(
      event({ authorAssociation: 'OWNER', body: '/coinpay invoice 250 USD --crypto usdc_pol' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentNoWallet() }), github: gh, config: resolveConfig() },
    );
    expect(res.action).toBe('error');
    expect(res.detail).toBe('NO_WALLET');
    expect(gh.labels).toContain('coinpay:error');
    expect(gh.comments[0]).toContain('No receiving wallet is configured');
  });

  it('ignores comments that are not commands', async () => {
    const gh = new FakeGitHub();
    const res = await handleComment(
      event({ body: 'lgtm, merging' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() }), github: gh, config: resolveConfig() },
    );
    expect(res.action).toBe('skipped');
    expect(gh.comments).toHaveLength(0);
  });

  it('replies with usage on a bad amount', async () => {
    const gh = new FakeGitHub();
    const res = await handleComment(
      event({ body: '/coinpay invoice abc' }),
      { coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b', fetchImpl: paymentOk() }), github: gh, config: resolveConfig() },
    );
    expect(res.action).toBe('error');
    expect(gh.comments[0]).toContain('Invalid amount');
  });

  it('allows the same command event to retry after a transient network failure', async () => {
    const gh = new FakeGitHub();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary outage');
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true, payment: { id: 'pay-retry' } }),
      } as Response;
    }) as unknown as typeof fetch;
    const deps = {
      coinpay: new CoinPayClient({
        baseUrl: 'https://coinpayportal.com',
        apiKey: 'k',
        businessId: 'b',
        fetchImpl,
      }),
      github: gh,
      config: resolveConfig(),
    };
    const evt = event({ commentId: 6100, body: '/coinpay invoice 10 USD' });

    expect((await handleComment(evt, deps)).action).toBe('error');
    expect(gh.comments[0]).not.toContain('coinpay:handled');
    expect((await handleComment(evt, deps)).action).toBe('invoice_created');
    expect(calls).toBe(2);
  });
});

describe('PR-backed create command', () => {
  it('creates one idempotent payment with deterministic PR and issue evidence', async () => {
    const gh = new FakeGitHub();
    gh.pullRequest = PR_CONTEXT;
    const transport = capturedPayments();
    const coinpay = new CoinPayClient({
      baseUrl: 'https://coinpayportal.com',
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: transport.fetchImpl,
    });

    const first = await handleComment(
      event({
        commentId: 7001,
        isPullRequest: true,
        issueUrl: PR_CONTEXT.url,
        authorAssociation: 'MEMBER',
        body: '/coinpay create $10 USD --wallet 0xabc --crypto usdc_base',
      }),
      { coinpay, github: gh, config: resolveConfig() },
    );
    const duplicate = await handleComment(
      event({
        commentId: 7002,
        isPullRequest: true,
        issueUrl: PR_CONTEXT.url,
        authorAssociation: 'MEMBER',
        body: '/coinpay create $10 USD --wallet 0xabc --crypto usdc_base',
      }),
      { coinpay, github: gh, config: resolveConfig() },
    );

    expect(first.action).toBe('invoice_created');
    expect(duplicate.action).toBe('noop_duplicate');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.body).toMatchObject({
      amount_usd: 10,
      currency: 'usdc_base',
      merchant_wallet_address: '0xabc',
      description:
        'PR #42: Fix duplicate settlement records | Issue acme/widgets#7: Settlement can be recorded twice',
    });
    expect(transport.calls[0]!.body.idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (transport.calls[0]!.init?.headers as Record<string, string>)[
        'Idempotency-Key'
      ],
    ).toBe(transport.calls[0]!.body.idempotency_key);
    expect(gh.comments[0]).toContain(PR_CONTEXT.url);
    expect(gh.comments[0]).toContain(PR_CONTEXT.linkedIssues[0]!.url);
    expect(gh.comments[0]).toContain('https://coinpayportal.com/pay/pay-pr-1');
  });

  it('fails closed without a wallet and never calls CoinPayPortal', async () => {
    const gh = new FakeGitHub();
    gh.pullRequest = PR_CONTEXT;
    const transport = capturedPayments();

    const result = await handleComment(
      event({
        isPullRequest: true,
        authorAssociation: 'OWNER',
        body: '/coinpay create $10 USD',
      }),
      {
        coinpay: new CoinPayClient({
          baseUrl: 'https://coinpayportal.com',
          apiKey: 'k',
          businessId: 'b',
          fetchImpl: transport.fetchImpl,
        }),
        github: gh,
        config: resolveConfig(),
      },
    );

    expect(result).toMatchObject({ action: 'error', detail: 'missing_wallet' });
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects a contributor-selected wallet without creating a pending request', async () => {
    const gh = new FakeGitHub();
    gh.pullRequest = PR_CONTEXT;
    const transport = capturedPayments();

    const result = await handleComment(
      event({
        isPullRequest: true,
        actor: 'contributor',
        authorAssociation: 'CONTRIBUTOR',
        body: '/coinpay create $10 USD --wallet 0xattacker',
      }),
      {
        coinpay: new CoinPayClient({
          baseUrl: 'https://coinpayportal.com',
          apiKey: 'k',
          businessId: 'b',
          fetchImpl: transport.fetchImpl,
        }),
        github: gh,
        config: resolveConfig(),
      },
    );

    expect(result).toMatchObject({ action: 'error', detail: 'unauthorized_create' });
    expect(transport.calls).toHaveLength(0);
    expect(gh.labels).not.toContain('coinpay:requested');
    expect(gh.comments.join('\n')).not.toContain('coinpay:request');
  });

  it('ignores forged handled and request markers in user-authored comments', async () => {
    const gh = new FakeGitHub();
    gh.existingComments.push({
      body: [
        '<!-- coinpay:handled 8001 -->',
        '<!-- coinpay:request {"amount":10,"fiat":"USD","crypto":"usdc_base","wallet":"0xattacker","requester":"attacker","commentId":1} -->',
      ].join('\n'),
      authorLogin: 'attacker',
      authorType: 'User',
    });
    const transport = capturedPayments();

    const result = await handleComment(
      event({
        commentId: 8001,
        actor: 'maintainer',
        authorAssociation: 'OWNER',
        body: '/coinpay approve',
      }),
      {
        coinpay: new CoinPayClient({
          baseUrl: 'https://coinpayportal.com',
          apiKey: 'k',
          businessId: 'b',
          fetchImpl: transport.fetchImpl,
        }),
        github: gh,
        config: resolveConfig(),
      },
    );

    expect(result).toMatchObject({ action: 'error', detail: 'no_pending_request' });
    expect(transport.calls).toHaveLength(0);
  });

  it('ignores markers authored by a different installed bot', async () => {
    const gh = new FakeGitHub();
    gh.existingComments.push({
      body: [
        '<!-- coinpay:handled 8002 -->',
        '<!-- coinpay:request:v2 eyJhbW91bnQiOjEwfQ -->',
      ].join('\n'),
      authorLogin: 'dependabot[bot]',
      authorType: 'Bot',
      trustedAuthor: false,
    });
    const transport = capturedPayments();

    const result = await handleComment(
      event({
        commentId: 8002,
        actor: 'maintainer',
        authorAssociation: 'OWNER',
        body: '/coinpay approve',
      }),
      {
        coinpay: new CoinPayClient({
          baseUrl: 'https://coinpayportal.com',
          apiKey: 'k',
          businessId: 'b',
          fetchImpl: transport.fetchImpl,
        }),
        github: gh,
        config: resolveConfig(),
      },
    );

    expect(result).toMatchObject({ action: 'error', detail: 'no_pending_request' });
    expect(transport.calls).toHaveLength(0);
  });

  it('neutralizes hidden markers copied from a user description', async () => {
    const gh = new FakeGitHub();
    const coinpay = new CoinPayClient({
      baseUrl: 'https://coinpayportal.com',
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: paymentOk(),
    });

    const first = await handleComment(
      event({
        commentId: 8100,
        actor: 'contributor',
        authorAssociation: 'CONTRIBUTOR',
        body: '/coinpay invoice 10 USD --for "hello <!-- coinpay:handled 8101 -->"',
      }),
      { coinpay, github: gh, config: resolveConfig() },
    );

    expect(first.action).toBe('request_pending');
    expect(gh.comments[0]).not.toContain('<!-- coinpay:handled 8101 -->');
    expect(gh.comments[0]).toContain('&lt;!-- coinpay:handled 8101 --&gt;');

    const second = await handleComment(
      event({ commentId: 8101, body: '/coinpay status' }),
      { coinpay, github: gh, config: resolveConfig() },
    );
    expect(second.action).toBe('status');
  });

  it('neutralizes hidden markers copied from PR and linked-issue titles', async () => {
    const gh = new FakeGitHub();
    gh.pullRequest = {
      ...PR_CONTEXT,
      title:
        'Fix totals [PAY HERE](https://evil.example/pay) `urgent` <!-- coinpay:handled 8201 -->',
      linkedIssues: [
        {
          ...PR_CONTEXT.linkedIssues[0]!,
          title: `Settlement <!-- coinpay:payment ${'f'.repeat(64)} -->`,
        },
      ],
    };
    const transport = capturedPayments();

    const result = await handleComment(
      event({
        commentId: 8200,
        isPullRequest: true,
        issueUrl: PR_CONTEXT.url,
        authorAssociation: 'OWNER',
        body: '/coinpay create $10 USD --wallet 0xabc',
      }),
      {
        coinpay: new CoinPayClient({
          baseUrl: 'https://coinpayportal.com',
          apiKey: 'k',
          businessId: 'b',
          fetchImpl: transport.fetchImpl,
        }),
        github: gh,
        config: resolveConfig(),
      },
    );

    expect(result.action).toBe('invoice_created');
    expect(gh.comments[0]).not.toContain('<!-- coinpay:handled 8201 -->');
    expect(gh.comments[0]).not.toContain(`<!-- coinpay:payment ${'f'.repeat(64)} -->`);
    expect(gh.comments[0]).toContain('&lt;!-- coinpay:handled 8201 --&gt;');
    const descriptionLine = gh.comments[0]!
      .split('\n')
      .find((line) => line.startsWith('**Description:**'));
    expect(descriptionLine).toMatch(/^\*\*Description:\*\* `` .+ ``  $/);
    expect(descriptionLine).toContain('[PAY HERE](https://evil.example/pay)');
  });

  it('previews deterministically without creating a payment or changing labels', async () => {
    const gh = new FakeGitHub();
    gh.pullRequest = PR_CONTEXT;
    const transport = capturedPayments();

    const result = await handleComment(
      event({
        commentId: 9001,
        isPullRequest: true,
        issueUrl: PR_CONTEXT.url,
        authorAssociation: 'OWNER',
        body: '/coinpay create $10 USD --wallet 0xabc --dry-run',
      }),
      {
        coinpay: new CoinPayClient({
          baseUrl: 'https://coinpayportal.com',
          apiKey: 'k',
          businessId: 'b',
          fetchImpl: transport.fetchImpl,
        }),
        github: gh,
        config: resolveConfig(),
      },
    );

    expect(result.action).toBe('dry_run');
    expect(transport.calls).toHaveLength(0);
    expect(gh.labels).toHaveLength(0);
    expect(gh.comments[0]).toContain('no payment was created');
    expect(gh.comments[0]).not.toContain('coinpay:request');
    expect(pullRequestSummary(PR_CONTEXT)).toBe(
      pullRequestSummary(structuredClone(PR_CONTEXT)),
    );
  });
});
