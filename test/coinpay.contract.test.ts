/**
 * Contract tests: pin the adapter to the shapes verified against coinpayportal
 * `master` (2026-07-07). If CoinPayPortal changes its contract, these fail
 * loudly here rather than silently in production (PRD §23 risk row 1).
 */
import { describe, it, expect } from 'vitest';
import { CoinPayClient, CoinPayError, verifyWebhookSignature, signWebhookPayload } from '../src/coinpay.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function mockFetch(status: number, jsonBody: unknown, capture?: (c: Captured) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    } as Response;
  }) as unknown as typeof fetch;
}

const VERIFIED_PAYMENT_RESPONSE = {
  success: true,
  payment: {
    id: '3f9c1e00-0000-4000-8000-000000000001',
    status: 'pending',
    amount: '250',
    amount_usd: '250',
    amount_crypto: '250.00',
    currency: 'usdc_pol',
    payment_address: '0xabc...',
    expires_at: '2026-07-07T12:15:00.000Z',
    metadata: { source: 'coinpaybot' },
  },
  usage: { current: 1, limit: 100, remaining: 99 },
};

describe('CoinPayClient.createPayment — request contract', () => {
  it('POSTs the verified payload with a Bearer API key', async () => {
    let captured: Captured | undefined;
    const client = new CoinPayClient({
      baseUrl: 'https://coinpayportal.com',
      apiKey: 'cp_live_test',
      businessId: 'biz_123',
      fetchImpl: mockFetch(201, VERIFIED_PAYMENT_RESPONSE, (c) => (captured = c)),
    });

    const res = await client.createPayment({
      amountUsd: 250,
      crypto: 'usdc_pol',
      description: 'Milestone 1',
      redirectUrl: 'https://github.com/o/r/issues/42',
      metadata: { github_issue_number: 42 },
    });

    expect(captured!.url).toBe('https://coinpayportal.com/api/payments/create');
    expect(captured!.method).toBe('POST');
    expect(captured!.headers['Authorization']).toBe('Bearer cp_live_test');
    expect(captured!.headers['Content-Type']).toBe('application/json');
    // Exact body shape the API expects.
    expect(captured!.body).toEqual({
      business_id: 'biz_123',
      amount_usd: 250,
      currency: 'usdc_pol',
      payment_method: 'crypto',
      description: 'Milestone 1',
      redirect_url: 'https://github.com/o/r/issues/42',
      metadata: { github_issue_number: 42 },
    });

    // Response parsing + link derivation (no payment_url in the response).
    expect(res.paymentId).toBe('3f9c1e00-0000-4000-8000-000000000001');
    expect(res.status).toBe('pending');
    expect(res.payLink).toBe('https://coinpayportal.com/pay/3f9c1e00-0000-4000-8000-000000000001');
  });

  it('includes merchant_wallet_address only when a wallet override is given', async () => {
    let captured: Captured | undefined;
    const client = new CoinPayClient({
      baseUrl: 'https://coinpayportal.com/', // trailing slash normalized
      apiKey: 'cp_live_x',
      businessId: 'biz_1',
      fetchImpl: mockFetch(201, VERIFIED_PAYMENT_RESPONSE, (c) => (captured = c)),
    });
    await client.createPayment({ amountUsd: 10, crypto: 'usdc_pol', walletAddress: '0xdeadbeef' });
    expect(captured!.body.merchant_wallet_address).toBe('0xdeadbeef');
    expect(captured!.url).toBe('https://coinpayportal.com/api/payments/create');
  });
});

describe('CoinPayClient.createPayment — error contract', () => {
  const base = { baseUrl: 'https://coinpayportal.com', apiKey: 'k', businessId: 'b' };

  it('maps the "no wallet configured" 400 to NO_WALLET', async () => {
    const client = new CoinPayClient({
      ...base,
      fetchImpl: mockFetch(400, { success: false, error: 'No USDC_POL wallet configured for this business. Please add a business wallet or merchant global wallet.' }),
    });
    await expect(client.createPayment({ amountUsd: 5, crypto: 'usdc_pol' })).rejects.toMatchObject({
      code: 'NO_WALLET',
    } satisfies Partial<CoinPayError>);
  });

  it('maps the 429 monthly-limit response to LIMIT and keeps usage', async () => {
    const client = new CoinPayClient({
      ...base,
      fetchImpl: mockFetch(429, { success: false, error: 'Monthly transaction limit exceeded', usage: { current: 100, limit: 100, remaining: 0 } }),
    });
    await client.createPayment({ amountUsd: 5, crypto: 'usdc_pol' }).catch((e: CoinPayError) => {
      expect(e.code).toBe('LIMIT');
      expect(e.usage).toEqual({ current: 100, limit: 100, remaining: 0 });
    });
    expect.assertions(2);
  });

  it('maps a Stripe-not-connected 400 to STRIPE_NOT_CONNECTED', async () => {
    const client = new CoinPayClient({
      ...base,
      fetchImpl: mockFetch(400, { success: false, error: 'Card payments require Stripe Connect. Please complete Stripe onboarding first.' }),
    });
    await expect(client.createPayment({ amountUsd: 5, crypto: 'usdc_pol' })).rejects.toMatchObject({ code: 'STRIPE_NOT_CONNECTED' });
  });

  it('maps 401 to AUTH', async () => {
    const client = new CoinPayClient({ ...base, fetchImpl: mockFetch(401, { error: 'Unauthorized' }) });
    await expect(client.createPayment({ amountUsd: 5, crypto: 'usdc_pol' })).rejects.toMatchObject({ code: 'AUTH' });
  });
});

describe('webhook signature contract (t=,v1= HMAC-SHA256 over ts.body)', () => {
  const secret = 'whsec_test';
  const rawBody = JSON.stringify({ event: 'payment.confirmed', payment_id: 'p1', status: 'confirmed' });
  const now = 1_800_000_000_000; // fixed clock (ms)
  const ts = Math.floor(now / 1000);

  it('accepts a signature this contract produces', () => {
    const header = signWebhookPayload(rawBody, secret, ts);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(rawBody, header, secret, 300, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = signWebhookPayload(rawBody, secret, ts);
    expect(verifyWebhookSignature(rawBody + ' ', header, secret, 300, now)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const header = signWebhookPayload(rawBody, secret, ts);
    expect(verifyWebhookSignature(rawBody, header, 'other', 300, now)).toBe(false);
  });

  it('rejects a stale timestamp outside tolerance', () => {
    const header = signWebhookPayload(rawBody, secret, ts - 600);
    expect(verifyWebhookSignature(rawBody, header, secret, 300, now)).toBe(false);
  });

  it('rejects malformed headers', () => {
    expect(verifyWebhookSignature(rawBody, 'garbage', secret, 300, now)).toBe(false);
    expect(verifyWebhookSignature(rawBody, 't=,v1=', secret, 300, now)).toBe(false);
  });
});
