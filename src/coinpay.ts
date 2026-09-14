/**
 * CoinPayPortal adapter.
 *
 * Every request/response shape here was verified against the live coinpayportal
 * `master` source at 86a4dd003c455df78c772a3f71bd8512eb7fbc84
 * (2026-08-28): src/app/api/payments/create/route.ts,
 * src/app/api/invoices/route.ts, src/lib/webhooks/service.ts, and
 * supabase/migrations/20260816020041_payment_idempotency_key.sql.
 *
 * Verified facts encoded below:
 *  - Auth: `Authorization: Bearer cp_live_...` works for both endpoints
 *    (payments/create reads the Bearer header only, not x-api-key).
 *  - payments/create body: { business_id, amount_usd, currency:<crypto>,
 *    payment_method:'crypto', description?, redirect_url?, merchant_wallet_address?, metadata? }
 *  - Response: { success:true, payment:{ id, status, amount_usd, amount_crypto, ... } }.
 *    There is NO payment_url — the pay link is derived as `${baseUrl}/pay/${id}`.
 *  - 400 "No {crypto} wallet configured..." when the business has no receiving
 *    wallet for the chain and no merchant_wallet_address override.
 *  - 429 with { usage } when the plan's monthly transaction cap is hit.
 *  - Idempotency: payments/create accepts `Idempotency-Key` or the
 *    `idempotency_key` body field, scopes lookup by business, stores the key in
 *    payment metadata, and returns the original payment on replay. A partial
 *    unique database index on (business_id, metadata.idempotency_key) closes
 *    the concurrent read-then-insert race, so retrying an ambiguous timeout or
 *    5xx with the same key cannot create a second payable payment.
 *  - Webhook signature header `X-CoinPay-Signature: t=<unix>,v1=<hex>` where
 *    hex = HMAC_SHA256(`${t}.${rawBody}`, webhook_secret), 300s tolerance.
 *
 * Invoice creation/publish shapes were verified against the coinpayportal
 * `feat/invoice-creation-idempotency` branch (2026-09-07):
 * src/app/api/invoices/route.ts, src/lib/invoices/creation.ts,
 * src/app/api/invoices/[id]/publish/route.ts, src/lib/invoices/activation.ts,
 * src/lib/payments/service.ts (case-sensitive uppercase Blockchain enum),
 * and supabase/migrations/20260907100000_invoice_creation_idempotency.sql.
 *  - POST /api/invoices with an `Idempotency-Key` header returns
 *    { success:true, invoice:<db row>, idempotentReplay:boolean } — 201 on
 *    first create, 200 on replay. 409 IDEMPOTENCY_CONFLICT for the same key
 *    with different terms, 410 INVOICE_DELETED once the original is deleted,
 *    429 SOURCE_RATE_LIMIT when the per-repository hourly cap is exhausted
 *    (replays bypass the cap), 503 while the idempotency migration is absent.
 *  - POST /api/invoices/{id}/publish returns { success:true, invoice,
 *    paymentLink:<absolute .../now/{id}>, emailAttempted:false,
 *    idempotentReplay } and can 409 (PAYMENT_CREATION_IN_PROGRESS /
 *    INVOICE_STATE_CHANGED) requiring a retry; only draft/sent publish, a
 *    closed invoice is 400 INVOICE_NOT_PUBLISHABLE and stays closed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type FetchLike = typeof fetch;

export interface CoinPayClientOptions {
  baseUrl: string;
  apiKey: string;
  businessId: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface CreatePaymentInput {
  amountUsd: number;
  /** CoinPayPortal crypto code, e.g. 'usdc_pol'. Sent as the `currency` field. */
  crypto: string;
  description?: string;
  /** Where CoinPayPortal redirects the payer after paying (the GitHub thread). */
  redirectUrl?: string;
  /** Optional payout override → `merchant_wallet_address`. */
  walletAddress?: string;
  metadata?: Record<string, unknown>;
  /** Stable payment identity, forwarded through both supported API forms. */
  idempotencyKey?: string;
}

export interface CreatePaymentResult {
  paymentId: string;
  status: string;
  payLink: string;
  amountUsd?: string | number;
  amountCrypto?: string | number;
  raw: unknown;
}

export type CoinPayErrorCode =
  | 'NO_WALLET'
  | 'LIMIT'
  | 'STRIPE_NOT_CONNECTED'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'NETWORK'
  // Invoice-flow codes, mapped from the verified /api/invoices contract:
  | 'IDEMPOTENCY_CONFLICT' // 409: key reused with different terms
  | 'INVOICE_DELETED' // 410: original invoice deleted; key can never recreate it
  | 'RATE_LIMIT' // 429: repository hourly cap exhausted (replays bypass it)
  | 'UNAVAILABLE' // 503: idempotency store unavailable (e.g. migration absent)
  | 'PUBLISH_RETRY' // 409 on publish: payment still being created / state changed
  | 'NOT_PUBLISHABLE' // 400 on publish: invoice is closed (paid/cancelled/...)
  | 'INVALID_RESPONSE'; // 2xx body that fails contract validation

export class CoinPayError extends Error {
  readonly code: CoinPayErrorCode;
  readonly status: number;
  readonly usage?: unknown;
  constructor(code: CoinPayErrorCode, message: string, status: number, usage?: unknown) {
    super(message);
    this.name = 'CoinPayError';
    this.code = code;
    this.status = status;
    this.usage = usage;
  }
}

function classify(status: number, body: { error?: string; usage?: unknown } | null): CoinPayError {
  const msg = body?.error ?? `HTTP ${status}`;
  if (status === 401 || status === 403) return new CoinPayError('AUTH', msg, status);
  if (status === 429) return new CoinPayError('LIMIT', msg, status, body?.usage);
  if (status >= 500) return new CoinPayError('SERVER', msg, status);
  if (status === 400) {
    if (/no .*wallet configured/i.test(msg)) return new CoinPayError('NO_WALLET', msg, status);
    if (/stripe/i.test(msg)) return new CoinPayError('STRIPE_NOT_CONNECTED', msg, status);
    return new CoinPayError('BAD_REQUEST', msg, status);
  }
  return new CoinPayError('BAD_REQUEST', msg, status);
}

/**
 * Error mapping for the invoice create/publish endpoints, which return typed
 * `code` fields. The raw `error` text is kept for Action logs only — the
 * handler renders fixed friendly text, never this message.
 */
function classifyInvoice(
  status: number,
  body: { error?: string; code?: string } | null,
): CoinPayError {
  const msg = body?.error ?? `HTTP ${status}`;
  const code = body?.code;
  if (status === 401 || status === 403) return new CoinPayError('AUTH', msg, status);
  if (status === 409) {
    // Anything other than a terms conflict (payment creation in progress,
    // invoice state changed, sent-without-address) is safe to retry later.
    return code === 'IDEMPOTENCY_CONFLICT'
      ? new CoinPayError('IDEMPOTENCY_CONFLICT', msg, status)
      : new CoinPayError('PUBLISH_RETRY', msg, status);
  }
  if (status === 410) return new CoinPayError('INVOICE_DELETED', msg, status);
  if (status === 429) return new CoinPayError('RATE_LIMIT', msg, status);
  if (status === 503) return new CoinPayError('UNAVAILABLE', msg, status);
  if (status >= 500) return new CoinPayError('SERVER', msg, status);
  if (status === 400) {
    if (code === 'INVOICE_NOT_PUBLISHABLE' || code === 'INVOICE_NOT_ACTIVATABLE') {
      return new CoinPayError('NOT_PUBLISHABLE', msg, status);
    }
    if (
      code === 'PAYEE_REQUIRED' ||
      code === 'PAYEE_INVALID' ||
      code === 'CRYPTO_REQUIRED' ||
      /no .*wallet configured/i.test(msg)
    ) {
      return new CoinPayError('NO_WALLET', msg, status);
    }
    return new CoinPayError('BAD_REQUEST', msg, status);
  }
  return new CoinPayError('BAD_REQUEST', msg, status);
}

/**
 * Audit trail forwarded to CoinPayPortal's `source_reference` (validated there
 * with the same shapes). `actorId` is the immutable numeric GitHub user id;
 * logins are display/audit data only — neither maps to a CoinPay account.
 */
export interface GithubInvoiceSource {
  /** `owner/repo` */
  repository: string;
  threadNumber: number;
  commentId: number;
  actorId: number;
  actorLogin: string;
  payerLogin: string;
}

export interface CreateInvoiceInput {
  amountUsd: number;
  /** CoinPayPortal crypto code the invoice settles in (from repo config). */
  cryptoCurrency: string;
  /** Stable plain-text notes: description + canonical GitHub thread URL. */
  notes: string;
  source: GithubInvoiceSource;
  /** Repository hourly cap the portal enforces atomically (1-1000). */
  sourceRateLimit: number;
  /** REQUIRED. Stable identity derived from repository ID + comment ID only. */
  idempotencyKey: string;
}

/** Fields validated out of a returned invoice row before anything is posted. */
export interface InvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  amountUsd: number;
  currency: string;
  /** Platform fee rate from the response (e.g. 0.01), never hardcoded. */
  feeRate: number | null;
}

export interface CreateInvoiceResult extends InvoiceSummary {
  idempotentReplay: boolean;
}

export interface PublishInvoiceResult extends InvoiceSummary {
  feeRate: number;
  /** Fee in USD, from the response (fee_amount, else amount × fee_rate). */
  feeAmountUsd: number;
  paymentAddress: string;
  /** Canonical checkout URL derived from the configured base URL. */
  paymentLink: string;
  idempotentReplay: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidResponse(detail: string): CoinPayError {
  return new CoinPayError('INVALID_RESPONSE', `Malformed CoinPayPortal invoice response: ${detail}`, 200);
}

function usdCents(value: unknown): number {
  const n = decimalNumber(value);
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) && n === cents / 100 ? cents : Number.NaN;
}

function decimalNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Validate an invoice row returned by CoinPayPortal against what we asked for.
 * Every field posted back to GitHub flows through this gate, so a malformed or
 * tampered response can never place foreign ids or amounts into a comment.
 */
function parseInvoiceSummary(
  invoice: unknown,
  expected: { businessId: string; amountUsd: number },
): InvoiceSummary {
  if (!invoice || typeof invoice !== 'object') throw invalidResponse('missing invoice');
  const row = invoice as Record<string, unknown>;
  if (typeof row['id'] !== 'string' || !UUID_RE.test(row['id'])) {
    throw invalidResponse('invoice id is not a UUID');
  }
  if (row['business_id'] !== expected.businessId) {
    throw invalidResponse('invoice belongs to a different business');
  }
  if (row['currency'] !== 'USD') throw invalidResponse('invoice currency is not USD');
  if (usdCents(row['amount']) !== usdCents(expected.amountUsd)) {
    throw invalidResponse('invoice amount differs from the requested amount');
  }
  if (typeof row['invoice_number'] !== 'string' || row['invoice_number'].trim() === '') {
    throw invalidResponse('invoice number missing');
  }
  if (typeof row['status'] !== 'string' || row['status'] === '') {
    throw invalidResponse('invoice status missing');
  }
  let feeRate: number | null = null;
  if (row['fee_rate'] !== null && row['fee_rate'] !== undefined) {
    feeRate = decimalNumber(row['fee_rate']);
    if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 1) throw invalidResponse('invalid fee rate');
  }
  return {
    invoiceId: row['id'],
    invoiceNumber: row['invoice_number'],
    status: row['status'],
    amountUsd: expected.amountUsd,
    currency: 'USD',
    feeRate,
  };
}

export class CoinPayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly businessId: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: CoinPayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.businessId = opts.businessId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Derive the hosted checkout link. Verified path shape: `/pay/{payment_id}`. */
  payLink(paymentId: string): string {
    return `${this.baseUrl}/pay/${paymentId}`;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const body: Record<string, unknown> = {
      business_id: this.businessId,
      amount_usd: input.amountUsd,
      currency: input.crypto,
      payment_method: 'crypto',
    };
    if (input.description) body['description'] = input.description;
    if (input.redirectUrl) body['redirect_url'] = input.redirectUrl;
    if (input.walletAddress) body['merchant_wallet_address'] = input.walletAddress;
    if (input.metadata) body['metadata'] = input.metadata;
    if (input.idempotencyKey) body['idempotency_key'] = input.idempotencyKey;

    const json = await this.post<{ success: boolean; payment?: any; error?: string; usage?: unknown }>(
      '/api/payments/create',
      body,
      input.idempotencyKey
        ? { 'Idempotency-Key': input.idempotencyKey }
        : undefined,
    );

    if (!json.success || !json.payment?.id) {
      throw new CoinPayError('BAD_REQUEST', json.error ?? 'Payment creation returned no payment', 200);
    }
    const p = json.payment;
    return {
      paymentId: p.id,
      status: p.status ?? 'pending',
      payLink: this.payLink(p.id),
      amountUsd: p.amount_usd ?? p.amount,
      amountCrypto: p.amount_crypto ?? p.crypto_amount,
      raw: json.payment,
    };
  }

  /** Hosted invoice checkout link. Verified path shape: `/now/{invoice_id}`. */
  invoiceLink(invoiceId: string): string {
    return `${this.baseUrl}/now/${invoiceId}`;
  }

  /** Optional download link only; never fetches a PDF or retries creation. */
  invoicePdfLink(invoiceId: string): string | null {
    if (!UUID_RE.test(invoiceId)) return null;
    try {
      const base = new URL(this.baseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
      if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) ||
          base.username || base.password || base.search || base.hash || base.pathname !== '/') return null;
      return new URL(`/api/invoices/${invoiceId}/pdf`, base).href;
    } catch {
      return null;
    }
  }

  /**
   * Create a draft invoice via the idempotent `POST /api/invoices` contract.
   * The business's configured payee is used — this request never names a
   * wallet, client, or email. A replay of the same key returns the original
   * invoice (200) whatever its current status; changed terms are a 409.
   */
  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const body = {
      business_id: this.businessId,
      amount: input.amountUsd,
      currency: 'USD',
      // Invoice publish passes this directly to the payment service's
      // uppercase Blockchain enum; the legacy payments API normalizes itself.
      crypto_currency: input.cryptoCurrency.toUpperCase(),
      notes: input.notes,
      source_reference: {
        provider: 'github',
        repository: input.source.repository,
        thread_number: input.source.threadNumber,
        comment_id: input.source.commentId,
        actor_id: input.source.actorId,
        actor_login: input.source.actorLogin,
        payer_login: input.source.payerLogin,
      },
      source_rate_limit: input.sourceRateLimit,
    };
    const res = await this.call('POST', '/api/invoices', body, {
      'Idempotency-Key': input.idempotencyKey,
    }, true);
    const json = (await res.json().catch(() => null)) as {
      success?: boolean; invoice?: unknown; idempotentReplay?: boolean;
      error?: string; code?: string;
    } | null;
    if (!res.ok) throw classifyInvoice(res.status, json);
    if (json?.success !== true || typeof json.idempotentReplay !== 'boolean') {
      throw invalidResponse('missing success/idempotentReplay');
    }
    const summary = parseInvoiceSummary(json.invoice, {
      businessId: this.businessId,
      amountUsd: input.amountUsd,
    });
    return { ...summary, idempotentReplay: json.idempotentReplay };
  }

  /**
   * Publish a draft/sent invoice via `POST /api/invoices/{id}/publish` —
   * creates live payment details WITHOUT emailing anyone. The returned row is
   * verified (sent + payment address + our business/amount) before the caller
   * may post a link, and the link itself is derived from the configured base
   * URL rather than trusted from the response body.
   */
  async publishInvoice(
    invoiceId: string,
    expected: { amountUsd: number },
  ): Promise<PublishInvoiceResult> {
    if (!UUID_RE.test(invoiceId)) throw invalidResponse('invoice id is not a UUID');
    const res = await this.call('POST', `/api/invoices/${invoiceId}/publish`, undefined, undefined, true);
    const json = (await res.json().catch(() => null)) as {
      success?: boolean; invoice?: unknown; paymentLink?: unknown;
      emailAttempted?: unknown; idempotentReplay?: boolean;
      error?: string; code?: string;
    } | null;
    if (!res.ok) throw classifyInvoice(res.status, json);
    if (json?.success !== true || typeof json.idempotentReplay !== 'boolean') throw invalidResponse('missing success/idempotentReplay');
    if (json.emailAttempted !== false) {
      // This endpoint's contract is publish-without-email. If that ever
      // changes, refuse loudly rather than silently emailing payers.
      throw invalidResponse('publish endpoint reported an email attempt');
    }
    const summary = parseInvoiceSummary(json.invoice, {
      businessId: this.businessId,
      amountUsd: expected.amountUsd,
    });
    if (summary.invoiceId !== invoiceId) throw invalidResponse('published a different invoice');
    if (summary.status !== 'sent') throw invalidResponse(`status is ${summary.status}, not sent`);
    if (summary.feeRate === null) throw invalidResponse('fee rate missing after publish');
    const row = json.invoice as Record<string, unknown>;
    if (typeof row['payment_address'] !== 'string' || row['payment_address'].trim() === '') {
      throw invalidResponse('payment address missing');
    }
    if (json.paymentLink !== this.invoiceLink(invoiceId)) {
      throw invalidResponse('payment link does not match the invoice');
    }
    // Activation returns amount * fee_rate without rounding to USD cents.
    // Validate that fee as a decimal; principal amounts still require whole cents.
    const feeAmountUsd = row['fee_amount'] !== null && row['fee_amount'] !== undefined
      ? decimalNumber(row['fee_amount'])
      : expected.amountUsd * summary.feeRate;
    if (!Number.isFinite(feeAmountUsd) || feeAmountUsd < 0 || feeAmountUsd > expected.amountUsd) {
      throw invalidResponse('invalid fee amount');
    }
    return {
      ...summary,
      feeRate: summary.feeRate,
      feeAmountUsd,
      paymentAddress: row['payment_address'],
      paymentLink: this.invoiceLink(invoiceId),
      idempotentReplay: json.idempotentReplay === true,
    };
  }

  /** Fetch current payment state (drives pull-only `/coinpay status`). */
  async getPayment(paymentId: string): Promise<{ status: string; raw: unknown }> {
    const res = await this.call('GET', `/api/payments/${encodeURIComponent(paymentId)}`);
    const json = (await res.json().catch(() => null)) as { payment?: any; status?: string; error?: string } | null;
    if (!res.ok) throw classify(res.status, json);
    const status = json?.payment?.status ?? json?.status ?? 'unknown';
    return { status, raw: json };
  }

  private async post<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const res = await this.call('POST', path, body, headers);
    const json = (await res.json().catch(() => null)) as (T & { error?: string; usage?: unknown }) | null;
    if (!res.ok) throw classify(res.status, json);
    if (json === null) throw new CoinPayError('SERVER', 'Empty response body', res.status);
    return json;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    invoiceRequest = false,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        ...(invoiceRequest ? { signal: AbortSignal.timeout(30000) } : {}),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new CoinPayError('NETWORK', err instanceof Error ? err.message : 'Network error', 0);
    }
  }
}

/**
 * Verify an inbound CoinPayPortal webhook signature.
 *
 * Header format (verified): `X-CoinPay-Signature: t=<unix_ts>,v1=<hex>`.
 * The signed message is `${t}.${rawBody}`, HMAC-SHA256 with the business webhook
 * secret. Pass the RAW request body bytes, not a re-serialized object.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
  nowMs: number = Date.now(),
): boolean {
  try {
    const parts: Record<string, string> = {};
    for (const part of signatureHeader.split(',')) {
      const idx = part.indexOf('=');
      if (idx > 0) parts[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    const t = parts['t'];
    const v1 = parts['v1'];
    if (!t || !v1) return false;

    const ts = Number.parseInt(t, 10);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSeconds) return false;

    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const a = Buffer.from(v1, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Produce a signature the way CoinPayPortal does — used by contract tests. */
export function signWebhookPayload(rawBody: string, secret: string, tsSeconds: number): string {
  const sig = createHmac('sha256', secret).update(`${tsSeconds}.${rawBody}`).digest('hex');
  return `t=${tsSeconds},v1=${sig}`;
}
