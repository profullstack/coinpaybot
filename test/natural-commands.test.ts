import { describe, it, expect } from 'vitest';
import { parseCommand, resolveCrypto } from '../src/parser.js';
import { handleComment } from '../src/handler.js';
import type { CommentEvent } from '../src/handler.js';
import { CoinPayClient } from '../src/coinpay.js';
import { resolveConfig } from '../src/config.js';
import type { GitHubClient, IssueRef, ThreadComment } from '../src/github.js';

describe('natural invoice grammar', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['/coinpay invoice $100usd in SOL', { amount: 100, fiat: 'USD', crypto: 'sol' }],
    ['/coinpay invoice $100 USD in sol', { amount: 100, fiat: 'USD', crypto: 'sol' }],
    ['/coinpay invoice 100 dollars in bitcoin', { amount: 100, crypto: 'btc' }],
    ['/coinpay invoice $25.50 in USDC on solana', { amount: 25.5, crypto: 'usdc_sol' }],
    ['/coinpay invoice 250 usd in usdc on base for "Milestone 1"', { amount: 250, crypto: 'usdc_base', description: 'Milestone 1' }],
    ['/coinpay invoice $40 for logo work in ETH', { amount: 40, crypto: 'eth', description: 'logo work' }],
    ['/coinpay invoice $40 for work in progress', { amount: 40, description: 'work in progress' }],
    ['/coinpay invoice 10 in USDC-POL', { amount: 10, crypto: 'usdc_pol' }],
    ['/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"', { amount: 250, crypto: 'usdc_pol', description: 'Milestone 1' }],
    ['/coinpay invoice $5 --crypto solana', { amount: 5, crypto: 'sol' }],
    ['/coinpay pay $100 in SOL', { amount: 100, crypto: 'sol' }],
  ];
  for (const [body, expected] of cases) {
    it(body, () => {
      expect(parseCommand(body)).toMatchObject({ kind: 'invoice', ...expected });
    });
  }

  it('rejects unknown coins and non-USD fiat with friendly errors', () => {
    expect(parseCommand('/coinpay invoice $100 in DOGGO')).toMatchObject({ kind: 'error', code: 'bad_crypto' });
    expect(parseCommand('/coinpay invoice 100eur in SOL')).toMatchObject({ kind: 'error' });
    expect(parseCommand('/coinpay invoice 100 EUR in SOL')).toMatchObject({ kind: 'error', code: 'bad_fiat' });
  });

  it('resolves crypto spellings', () => {
    expect(resolveCrypto('USDT', 'polygon')).toBe('usdt_pol');
    expect(resolveCrypto('sol', 'solana')).toBe('sol');
    expect(resolveCrypto('usdc', 'bitcoin')).toBeNull();
    expect(resolveCrypto('usdc_base')).toBe('usdc_base');
  });

  it('parses connect and setup', () => {
    expect(parseCommand('/coinpay connect')).toEqual({ kind: 'connect' });
    expect(parseCommand('/coinpay setup')).toEqual({ kind: 'connect' });
  });
});

class FakeGitHub implements GitHubClient {
  comments: string[] = [];
  async listComments(_ref: IssueRef): Promise<ThreadComment[]> {
    return this.comments.map((body) => ({ body, authorLogin: 'github-actions[bot]', authorType: 'Bot', trustedAuthor: true }));
  }
  async getPullRequestContext() { return null; }
  async createComment(_ref: IssueRef, body: string): Promise<void> { this.comments.push(body); }
  async addLabels(): Promise<void> {}
}

function evt(body: string, commentId = 1): CommentEvent {
  return {
    ref: { owner: 'profullstack', repo: 'demo', issueNumber: 7 },
    repositoryId: 99, commentId, body, actor: 'anthony', actorId: 1, actorType: 'User',
    authorAssociation: 'OWNER', issueUrl: 'https://github.com/profullstack/demo/issues/7', isPullRequest: false,
  };
}

describe('connect flow', () => {
  const noNetwork = (async () => { throw new Error('network must not be used'); }) as unknown as typeof fetch;
  const deps = (connected: boolean, gh: FakeGitHub) => ({
    coinpay: new CoinPayClient({ baseUrl: 'https://coinpayportal.com', apiKey: '', businessId: '', fetchImpl: noNetwork }),
    github: gh, config: resolveConfig(), connected, baseUrl: 'https://coinpayportal.com', repoFullName: 'profullstack/demo',
  });

  it('explains how to connect an unconnected repo', async () => {
    const gh = new FakeGitHub();
    expect((await handleComment(evt('/coinpay connect'), deps(false, gh))).action).toBe('connect');
    expect(gh.comments[0]).toContain('gh secret set COINPAY_API_KEY -R profullstack/demo');
  });

  it('answers an invoice on an unconnected repo with setup steps instead of failing', async () => {
    const gh = new FakeGitHub();
    expect((await handleComment(evt('/coinpay invoice $100usd in SOL'), deps(false, gh))).action).toBe('not_connected');
    expect(gh.comments[0]).toContain('needs this repository connected');
  });

  it('confirms a connected repo, once per comment', async () => {
    const gh = new FakeGitHub();
    const d = deps(true, gh);
    expect((await handleComment(evt('/coinpay connect', 5), d)).action).toBe('connect');
    expect((await handleComment(evt('/coinpay connect', 5), d)).action).toBe('noop_duplicate');
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain('is connected');
  });

  it('still shows help on an unconnected repo', async () => {
    const gh = new FakeGitHub();
    expect((await handleComment(evt('/coinpay help'), deps(false, gh))).action).toBe('help');
    expect(gh.comments[0]).toContain('in SOL');
  });
});
