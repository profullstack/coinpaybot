/**
 * CoinPayPortal adapter.
 *
 * Every request/response shape here was verified against the live coinpayportal
 * `master` source (2026-07-07): src/app/api/payments/create/route.ts,
 * src/app/api/invoices/route.ts, and src/lib/webhooks/service.ts.
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
 *  - Webhook signature header `X-CoinPay-Signature: t=<unix>,v1=<hex>` where
 *    hex = HMAC_SHA256(`${t}.${rawBody}`, webhook_secret), 300s tolerance.
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
  | 'NETWORK';

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

    const json = await this.post<{ success: boolean; payment?: any; error?: string; usage?: unknown }>(
      '/api/payments/create',
      body,
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

  /** Fetch current payment state (drives pull-only `/coinpay status`). */
  async getPayment(paymentId: string): Promise<{ status: string; raw: unknown }> {
    const res = await this.call('GET', `/api/payments/${encodeURIComponent(paymentId)}`);
    const json = (await res.json().catch(() => null)) as { payment?: any; status?: string; error?: string } | null;
    if (!res.ok) throw classify(res.status, json);
    const status = json?.payment?.status ?? json?.status ?? 'unknown';
    return { status, raw: json };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.call('POST', path, body);
    const json = (await res.json().catch(() => null)) as (T & { error?: string; usage?: unknown }) | null;
    if (!res.ok) throw classify(res.status, json);
    if (json === null) throw new CoinPayError('SERVER', 'Empty response body', res.status);
    return json;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
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
