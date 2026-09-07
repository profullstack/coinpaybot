/**
 * Contract tests for the idempotent invoice create/publish adapter. Shapes are
 * pinned to the coinpayportal `feat/invoice-creation-idempotency` sources
 * (src/app/api/invoices/route.ts, src/lib/invoices/creation.ts,
 * src/app/api/invoices/[id]/publish/route.ts, src/lib/invoices/activation.ts).
 * If the portal contract changes, these fail loudly here.
 */
import { describe, it, expect } from 'vitest';
import { CoinPayClient, CoinPayError } from '../src/coinpay.js';
import type { CreateInvoiceInput } from '../src/coinpay.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | null;
}

function mockFetch(status: number, jsonBody: unknown, capture?: (c: Captured) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      signal: init?.signal,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    } as Response;
  }) as unknown as typeof fetch;
}

const INVOICE_ID = '3f9c1e00-0000-4000-8000-00000000aa01';
const BUSINESS_ID = 'biz_123';

/** Invoice row as the portal returns it (numerics may arrive as strings). */
function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVOICE_ID,
    user_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    business_id: BUSINESS_ID,
    client_id: null,
    invoice_number: 'INV-042',
    status: 'draft',
    currency: 'USD',
    amount: '25',
    crypto_currency: 'USDC_POL',
    merchant_wallet_address: null,
    wallet_id: null,
    fee_rate: '0.01',
    due_date: null,
    notes: 'Fix the settlement race\n\nhttps://github.com/acme/widgets/issues/42#issuecomment-9001',
    metadata: {
      source_reference: {
        provider: 'github', repository: 'acme/widgets', thread_number: 42,
        comment_id: 9001, actor_id: 555, actor_login: 'octocat', payer_login: 'hubber',
      },
    },
    clients: null,
    businesses: { id: BUSINESS_ID, name: 'Acme LLC' },
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    amountUsd: 25,
    cryptoCurrency: 'usdc_pol',
    notes: 'Fix the settlement race\n\nhttps://github.com/acme/widgets/issues/42#issuecomment-9001',
    source: {
      repository: 'acme/widgets',
      threadNumber: 42,
      commentId: 9001,
      actorId: 555,
      actorLogin: 'octocat',
      payerLogin: 'hubber',
    },
    sourceRateLimit: 20,
    idempotencyKey: 'github:acme/widgets:comment:9001',
    ...overrides,
  };
}

function client(fetchImpl: typeof fetch): CoinPayClient {
  return new CoinPayClient({
    baseUrl: 'https://coinpayportal.com',
    apiKey: 'cp_live_test',
    businessId: BUSINESS_ID,
    fetchImpl,
  });
}

describe('CoinPayClient.createInvoice — request contract', () => {
  it('POSTs the exact verified payload with Bearer auth and a required Idempotency-Key', async () => {
    let captured: Captured | undefined;
    const c = client(mockFetch(201, {
      success: true, invoice: invoiceRow(), idempotentReplay: false,
    }, (x) => (captured = x)));

    const res = await c.createInvoice(createInput());

    expect(captured!.url).toBe('https://coinpayportal.com/api/invoices');
    expect(captured!.method).toBe('POST');
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
    expect(captured!.signal!.aborted).toBe(false);
    expect(captured!.headers['Authorization']).toBe('Bearer cp_live_test');
    expect(captured!.headers['Idempotency-Key']).toBe('github:acme/widgets:comment:9001');
    // Exact body: notably NO client_id, wallet, email, due date, or schedule —
    // the business's configured payee is always used.
    expect(captured!.body).toEqual({
      business_id: BUSINESS_ID,
      amount: 25,
      currency: 'USD',
      crypto_currency: 'USDC_POL',
      notes: 'Fix the settlement race\n\nhttps://github.com/acme/widgets/issues/42#issuecomment-9001',
      source_reference: {
        provider: 'github',
        repository: 'acme/widgets',
        thread_number: 42,
        comment_id: 9001,
        actor_id: 555,
        actor_login: 'octocat',
        payer_login: 'hubber',
      },
      source_rate_limit: 20,
    });

    expect(res).toMatchObject({
      invoiceId: INVOICE_ID,
      invoiceNumber: 'INV-042',
      status: 'draft',
      amountUsd: 25,
      currency: 'USD',
      feeRate: 0.01,
      idempotentReplay: false,
    });
  });

  it('reports a 200 replay of the original invoice as idempotentReplay', async () => {
    const c = client(mockFetch(200, {
      success: true, invoice: invoiceRow({ status: 'sent' }), idempotentReplay: true,
    }));
    const res = await c.createInvoice(createInput());
    expect(res.idempotentReplay).toBe(true);
    expect(res.status).toBe('sent');
  });
});

describe('CoinPayClient.createInvoice — error contract', () => {
  it.each([
    [409, { success: false, error: 'This key was already used with different invoice terms', code: 'IDEMPOTENCY_CONFLICT' }, 'IDEMPOTENCY_CONFLICT'],
    [410, { success: false, error: 'The original invoice was deleted; this key cannot create another', code: 'INVOICE_DELETED' }, 'INVOICE_DELETED'],
    [429, { success: false, error: 'Repository invoice rate limit reached; retry later with the same key', code: 'SOURCE_RATE_LIMIT' }, 'RATE_LIMIT'],
    [503, { success: false, error: 'Invoice idempotency is unavailable; retry later', code: 'IDEMPOTENCY_UNAVAILABLE' }, 'UNAVAILABLE'],
    [400, { success: false, error: 'No usdc_pol payee is configured for this business.', code: 'PAYEE_REQUIRED' }, 'NO_WALLET'],
    [401, { success: false, error: 'Invalid API key' }, 'AUTH'],
    [500, { success: false, error: 'Internal server error' }, 'SERVER'],
  ])('maps %s %j to %s', async (status, body, code) => {
    const c = client(mockFetch(status as number, body));
    await expect(c.createInvoice(createInput())).rejects.toMatchObject({ code });
  });

  it.each([
    ['missing invoice', { success: true, idempotentReplay: false }],
    ['missing idempotentReplay', { success: true, invoice: invoiceRow() }],
    ['non-uuid id', { success: true, invoice: invoiceRow({ id: '../evil' }), idempotentReplay: false }],
    ['foreign business', { success: true, invoice: invoiceRow({ business_id: 'biz_other' }), idempotentReplay: false }],
    ['tampered amount', { success: true, invoice: invoiceRow({ amount: '250' }), idempotentReplay: false }],
    ['fractional cent', { success: true, invoice: invoiceRow({ amount: '25.001' }), idempotentReplay: false }],
    ['hex amount', { success: true, invoice: invoiceRow({ amount: '0x19' }), idempotentReplay: false }],
    ['non-USD currency', { success: true, invoice: invoiceRow({ currency: 'EUR' }), idempotentReplay: false }],
    ['missing invoice number', { success: true, invoice: invoiceRow({ invoice_number: '' }), idempotentReplay: false }],
    ['negative fee rate', { success: true, invoice: invoiceRow({ fee_rate: '-0.5' }), idempotentReplay: false }],
    ['boolean fee rate', { success: true, invoice: invoiceRow({ fee_rate: true }), idempotentReplay: false }],
    ['excessive fee rate', { success: true, invoice: invoiceRow({ fee_rate: 1.01 }), idempotentReplay: false }],
  ])('rejects a malformed 2xx response: %s', async (_name, body) => {
    const c = client(mockFetch(201, body));
    await expect(c.createInvoice(createInput())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

function publishResponse(overrides: {
  invoice?: Record<string, unknown>;
  paymentLink?: unknown;
  emailAttempted?: unknown;
  idempotentReplay?: boolean;
} = {}) {
  return {
    success: true,
    invoice: invoiceRow({
      status: 'sent',
      payment_address: '0xpaymentaddr',
      crypto_amount: '25.00000000',
      fee_amount: 0.25,
      ...(overrides.invoice ?? {}),
    }),
    paymentLink: 'paymentLink' in overrides
      ? overrides.paymentLink
      : `https://coinpayportal.com/now/${INVOICE_ID}`,
    emailAttempted: 'emailAttempted' in overrides ? overrides.emailAttempted : false,
    idempotentReplay: overrides.idempotentReplay ?? false,
  };
}

describe('CoinPayClient.publishInvoice — contract', () => {
  it('POSTs to the publish endpoint and verifies the sent invoice before returning', async () => {
    let captured: Captured | undefined;
    const c = client(mockFetch(200, publishResponse(), (x) => (captured = x)));

    const res = await c.publishInvoice(INVOICE_ID, { amountUsd: 25 });

    expect(captured!.url).toBe(`https://coinpayportal.com/api/invoices/${INVOICE_ID}/publish`);
    expect(captured!.method).toBe('POST');
    expect(captured!.headers['Authorization']).toBe('Bearer cp_live_test');
    expect(res).toMatchObject({
      invoiceId: INVOICE_ID,
      invoiceNumber: 'INV-042',
      status: 'sent',
      paymentAddress: '0xpaymentaddr',
      feeRate: 0.01,
      feeAmountUsd: 0.25,
      idempotentReplay: false,
    });
  });

  it('rejects a payment link on another deployment instead of guessing which one is live', async () => {
    const c = client(mockFetch(200, publishResponse({
      paymentLink: `https://app.internal.coinpayportal.com/now/${INVOICE_ID}`,
    })));
    await expect(c.publishInvoice(INVOICE_ID, { amountUsd: 25 })).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
  });

  it('computes the fee from the returned fee_rate when fee_amount is absent', async () => {
    const c = client(mockFetch(200, publishResponse({
      invoice: { fee_amount: null, fee_rate: '0.013' },
    })));
    const res = await c.publishInvoice(INVOICE_ID, { amountUsd: 25 });
    expect(res.feeRate).toBe(0.013);
    expect(res.feeAmountUsd).toBe(0.325);
  });

  it.each([
    [20.13, '0.01', 0.2013, 0.2013],
    [20.13, '0.01', '0.20130000', 0.2013],
    [1, '0.005', 0.005, 0.005],
    [0.1, '0.005', '0.00050000', 0.0005],
  ])('accepts the unrounded activation fee for a %s USD invoice', async (amount, rate, fee, expectedFee) => {
    const c = client(mockFetch(200, publishResponse({
      invoice: { amount, fee_rate: rate, fee_amount: fee },
    })));
    const res = await c.publishInvoice(INVOICE_ID, { amountUsd: amount as number });
    expect(res.feeAmountUsd).toBe(expectedFee);
    expect(res.paymentLink).toBe(`https://coinpayportal.com/now/${INVOICE_ID}`);
  });

  it.each([
    ['not sent', { invoice: { status: 'draft' } }],
    ['missing payment address', { invoice: { payment_address: '' } }],
    ['different invoice id', { invoice: { id: '3f9c1e00-0000-4000-8000-00000000bb02' } }],
    ['payment link for another invoice', { paymentLink: 'https://coinpayportal.com/now/3f9c1e00-0000-4000-8000-00000000bb02' }],
    ['missing payment link', { paymentLink: null }],
    ['email attempted', { emailAttempted: true }],
    ['missing fee rate', { invoice: { fee_rate: null } }],
    ['boolean fee amount', { invoice: { fee_amount: false } }],
    ['fee exceeds invoice', { invoice: { fee_amount: 26 } }],
    ['negative fee amount', { invoice: { fee_amount: -0.005 } }],
    ['nonfinite fee string', { invoice: { fee_amount: 'Infinity' } }],
    ['invalid fee string', { invoice: { fee_amount: 'not-a-number' } }],
    ['fractional invoice cent', { invoice: { amount: 25.001 } }],
    ['tampered amount', { invoice: { amount: 2500 } }],
  ])('refuses to return an unverified publish response: %s', async (_name, overrides) => {
    const c = client(mockFetch(200, publishResponse(overrides as never)));
    await expect(c.publishInvoice(INVOICE_ID, { amountUsd: 25 })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('never requests a non-UUID invoice id', async () => {
    let called = false;
    const c = client(mockFetch(200, publishResponse(), () => (called = true)));
    await expect(c.publishInvoice('../mark-paid', { amountUsd: 25 })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(called).toBe(false);
  });

  it.each([
    [409, { success: false, error: 'Invoice payment is still being created; retry shortly', code: 'PAYMENT_CREATION_IN_PROGRESS' }, 'PUBLISH_RETRY'],
    [409, { success: false, error: 'Invoice changed while payment details were being created; refresh and retry', code: 'INVOICE_STATE_CHANGED' }, 'PUBLISH_RETRY'],
    [409, { success: false, error: 'Invoice is sent but has no active payment details', code: 'PAYMENT_ADDRESS_MISSING' }, 'PUBLISH_RETRY'],
    [400, { success: false, error: 'Cannot publish invoice with status: paid', code: 'INVOICE_NOT_PUBLISHABLE' }, 'NOT_PUBLISHABLE'],
  ])('maps publish %s %j to %s', async (status, body, code) => {
    const c = client(mockFetch(status as number, body));
    await expect(c.publishInvoice(INVOICE_ID, { amountUsd: 25 })).rejects.toMatchObject({ code });
  });

  it('keeps raw API error text off the CoinPayError code path used for comments', async () => {
    const c = client(mockFetch(503, {
      success: false,
      error: 'relation "invoice_creation_requests" does not exist',
      code: 'IDEMPOTENCY_UNAVAILABLE',
    }));
    const err = await c.createInvoice(createInput()).catch((e: CoinPayError) => e);
    expect(err).toBeInstanceOf(CoinPayError);
    // The raw text is preserved for Action logs on the error object itself…
    expect((err as CoinPayError).message).toContain('invoice_creation_requests');
    // …but the code is what the handler renders from (fixed strings only).
    expect((err as CoinPayError).code).toBe('UNAVAILABLE');
  });
});
