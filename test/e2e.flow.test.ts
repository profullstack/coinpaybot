/**
 * End-to-end command flow with in-memory fakes for GitHub and a mocked
 * CoinPayPortal transport. Exercises parser → permissions → adapter →
 * comment/label posting exactly as the Action would at runtime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CoinPayClient } from '../src/coinpay.js';
import type { GitHubClient, IssueRef } from '../src/github.js';
import { handleComment } from '../src/handler.js';
import type { CommentEvent } from '../src/handler.js';
import { resolveConfig } from '../src/config.js';

class FakeGitHub implements GitHubClient {
  comments: string[] = [];
  labels: string[] = [];
  async listCommentBodies(_ref: IssueRef): Promise<string[]> {
    return [...this.comments];
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

const REF: IssueRef = { owner: 'acme', repo: 'widgets', issueNumber: 42 };

function event(overrides: Partial<CommentEvent>): CommentEvent {
  return {
    ref: REF,
    commentId: 1001,
    body: '',
    actor: 'octocat',
    authorAssociation: 'OWNER',
    issueUrl: 'https://github.com/acme/widgets/issues/42',
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
});
