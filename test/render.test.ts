import { describe, expect, it } from 'vitest';
import {
  findPendingRequest,
  pendingComment,
  requestMarker,
} from '../src/render.js';

function trustedMarker(value: Record<string, unknown>) {
  return [{
    body: requestMarker(value as never),
    authorLogin: 'github-actions[bot]',
    authorType: 'Bot',
    trustedAuthor: true,
  }];
}

const VALID_REQUEST = {
  amount: 10,
  fiat: 'USD',
  crypto: 'usdc_sol',
  requester: 'octocat',
  commentId: 42,
};

describe('pending request marker validation', () => {
  it('accepts a canonical request emitted by the bot', () => {
    expect(findPendingRequest(trustedMarker(VALID_REQUEST))).toMatchObject(
      VALID_REQUEST,
    );
  });

  it.each([
    { ...VALID_REQUEST, amount: 1.001 },
    { ...VALID_REQUEST, amount: 1_000_000_000 },
    { ...VALID_REQUEST, fiat: 'EUR' },
    { ...VALID_REQUEST, crypto: 'usdc_moon' },
    { ...VALID_REQUEST, requester: '   ' },
  ])('rejects marker state outside the command grammar: %o', (request) => {
    expect(findPendingRequest(trustedMarker(request))).toBeNull();
  });
});

describe('pending approval comment rendering', () => {
  it('renders an untrusted description as inert code-span text', () => {
    const description = '[PAY HERE](https://evil.example) `urgent` <!-- hidden -->';
    const body = pendingComment({
      request: { ...VALID_REQUEST, description },
      approveCommand: '/coinpay approve',
      handledCommentId: 42,
    });

    expect(body).toContain(
      '> `` [PAY HERE](https://evil.example) `urgent` &lt;!-- hidden --&gt; ``',
    );
    expect(body).not.toContain('> [PAY HERE](https://evil.example)');
  });
});
