/** Fixed-origin, integer-only contributor ledger transport. Never broadcasts a payout. */
export const CONTRIBUTIONS_ORIGIN = 'https://coinpayportal.com';
export const CONTRIBUTIONS_AUDIENCE = 'coinpayportal.com';
const ROOT = '/api/github/contributions';
const UINT = /^(0|[1-9][0-9]{0,39})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ContributionIdentity {
  repository_id: string;
  repository_owner_id: string;
  repository_full_name: string;
  pull_request_id: string;
  pull_request_number: number;
  contributor_id: string;
  contributor_login: string;
  merged_at: string;
  merge_commit_sha: string;
}

export interface ContributionBalance {
  currency: 'USD';
  accrued_mills: string;
  reserved_mills: string;
  paid_mills: string;
  available_mills: string;
  payable_cents: string;
  remainder_mills: string;
}

export interface SettlementRequest {
  repository_id: string;
  repository_owner_id: string;
  repository_full_name: string;
  contributor_id: string;
  recipient_wallet: string;
  blockchain: string;
  idempotency_key: string;
}

export interface ContributionSettlement {
  id: string;
  contributor_id: string;
  currency: 'USD';
  status: 'reserved' | 'awaiting_payment' | 'paid';
  amount_cents: string;
  payment_url: string | null;
  payment_status: string | null;
}

export class ContributionError extends Error {
  constructor(public readonly code: string, public readonly status = 0) {
    super(`CoinPay contribution request failed (${code}).`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContributionError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function integer(value: unknown): string {
  if (typeof value !== 'string' || !UINT.test(value)) throw new ContributionError('INVALID_RESPONSE');
  return value;
}

export function parseBalance(value: unknown): ContributionBalance {
  const raw = object(value);
  if (raw['currency'] !== 'USD') throw new ContributionError('INVALID_RESPONSE');
  const balance: ContributionBalance = {
    currency: 'USD', reserved_mills: integer(raw['reserved_mills']), paid_mills: integer(raw['paid_mills']),
    accrued_mills: integer(raw['accrued_mills']), available_mills: integer(raw['available_mills']),
    payable_cents: integer(raw['payable_cents']), remainder_mills: integer(raw['remainder_mills']),
  };
  const available = BigInt(balance.available_mills);
  if (available + BigInt(balance.reserved_mills) + BigInt(balance.paid_mills) !== BigInt(balance.accrued_mills) ||
      BigInt(balance.payable_cents) !== available / 10n ||
      BigInt(balance.remainder_mills) !== available % 10n) throw new ContributionError('INVALID_RESPONSE');
  return balance;
}

export function millsUsd(value: string): string {
  const mills = BigInt(integer(value));
  return `${mills / 1000n}.${String(mills % 1000n).padStart(3, '0')}`;
}

export function centsUsd(value: string): string {
  const cents = BigInt(integer(value));
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function settlement(value: unknown): ContributionSettlement {
  const raw = object(value);
  if (typeof raw['id'] !== 'string' || !UUID.test(raw['id']) ||
      raw['currency'] !== 'USD' || typeof raw['contributor_id'] !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(raw['contributor_id']) ||
      !['reserved', 'awaiting_payment', 'paid'].includes(String(raw['status']))) throw new ContributionError('INVALID_RESPONSE');
  const amount = integer(raw['amount_cents']);
  if (amount === '0') throw new ContributionError('INVALID_RESPONSE');
  let url: string | null = null;
  if (raw['payment_url'] !== null && raw['payment_url'] !== undefined) {
    if (typeof raw['payment_url'] !== 'string') throw new ContributionError('INVALID_RESPONSE');
    try {
      const parsed = new URL(raw['payment_url']);
      if (parsed.origin !== CONTRIBUTIONS_ORIGIN || parsed.username || parsed.password ||
          !parsed.pathname.startsWith('/pay/') || !UUID.test(parsed.pathname.slice(5)) || parsed.search || parsed.hash) throw new Error();
      url = parsed.href;
    } catch { throw new ContributionError('INVALID_RESPONSE'); }
  }
  if (url && (raw['status'] !== 'awaiting_payment' || raw['payment_status'] !== 'pending')) throw new ContributionError('INVALID_RESPONSE');
  return { id: raw['id'], contributor_id: raw['contributor_id'], currency: 'USD',
    status: raw['status'] as ContributionSettlement['status'], amount_cents: amount,
    payment_url: url, payment_status: typeof raw['payment_status'] === 'string' ? raw['payment_status'].slice(0,64) : null };
}

export class ContributionClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, body?: object, oidc?: string): Promise<Record<string, unknown>> {
    if (body && (!oidc || /[\r\n]/.test(oidc))) throw new ContributionError('OIDC_REQUIRED');
    let response: Response;
    try {
      response = await this.fetcher(CONTRIBUTIONS_ORIGIN + ROOT + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'X-GitHub-Actions-Token': oidc! } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new ContributionError('TRANSPORT_UNAVAILABLE'); }
    // Never log upstream response bodies, tokens, wallet addresses or exception text.
    if (!response.ok) {
      await response.body?.cancel();
      throw new ContributionError(response.status === 409 ? 'CONFLICT_OR_PRE_ENROLLMENT' :
        response.status === 401 || response.status === 403 ? 'AUTHORIZATION_FAILED' : 'UPSTREAM_UNAVAILABLE', response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ContributionError('INVALID_RESPONSE');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); throw new ContributionError('INVALID_RESPONSE'); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ContributionError) throw error;
      throw new ContributionError('TRANSPORT_UNAVAILABLE');
    }
    let raw: Record<string, unknown>;
    try { raw = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new ContributionError('INVALID_RESPONSE'); }
    if (raw['success'] !== true) throw new ContributionError('INVALID_RESPONSE');
    return raw;
  }

  async accrue(identity: ContributionIdentity, oidc: string) {
    const raw = await this.request('/accrue', identity, oidc);
    const contribution = object(raw['contribution']);
    if (contribution['amount_mills'] !== '1' || contribution['currency'] !== 'USD' || typeof raw['replayed'] !== 'boolean') {
      throw new ContributionError('INVALID_RESPONSE');
    }
    return { replayed: raw['replayed'], balance: parseBalance(raw['balance']) };
  }

  async balance(repositoryId: string, contributorId: string) {
    const query = new URLSearchParams({repository_id: repositoryId, contributor_id: contributorId});
    return parseBalance((await this.request('/balance?' + query)).balance);
  }

  async settle(body: SettlementRequest, oidc: string) {
    const raw = await this.request('/settlements', body, oidc);
    const balance = parseBalance(raw['balance']);
    if (raw['settlement'] === null) {
      if (raw['code'] !== 'BELOW_CENT' || BigInt(balance.available_mills) >= 10n) throw new ContributionError('INVALID_RESPONSE');
      return { settlement: null, balance };
    }
    const parsed = settlement(raw['settlement']);
    if (parsed.contributor_id !== body.contributor_id) throw new ContributionError('INVALID_RESPONSE');
    return { settlement: parsed, balance };
  }
}
