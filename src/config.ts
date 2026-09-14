/**
 * Repository configuration (.github/coinpay.yml) merged over product defaults.
 * Config precedence (PRD §15): command args > repo file > product defaults.
 * (Org/app dashboard defaults are a hosted-App concern, not the Action MVP.)
 */

import { isCanonicalUsdAmount, SUPPORTED_CRYPTO } from './parser.js';

export type MinRole = 'owner' | 'member' | 'collaborator';

/**
 * `/coinpay create @payer ...` — publish a real CoinPayPortal invoice from a
 * comment. Ships disabled: enabling it requires the CoinPayPortal idempotent
 * invoice-creation deployment (API + migration) to be live first, otherwise
 * every command fails with a 503.
 */
export interface GithubInvoiceConfig {
  enabled: boolean;
  /** Enable only after the public invoice PDF endpoint is deployed. */
  pdfEnabled: boolean;
  /** Upper bound for a single invoice in USD. */
  maxAmountUsd: number;
  /** Per-repository hourly invoice cap enforced atomically by CoinPayPortal (1-1000). */
  repositoryHourlyCap: number;
}

export interface ContributionRewardsConfig {
  enabled: boolean;
  rateUsd: '0.001';
  payment: 'manual';
}

export interface LabelConfig {
  requested: string;
  pending: string;
  approved: string;
  paid: string;
  expired: string;
  cancelled: string;
  error: string;
}

export interface ResolvedConfig {
  enabled: boolean;
  defaultCrypto: string;
  defaultFiat: string;
  /** Minimum GitHub author_association allowed to create an invoice directly. */
  minRoleToCreateInvoice: MinRole;
  requireApprovalForNonMaintainers: boolean;
  labels: LabelConfig;
  githubInvoices: GithubInvoiceConfig;
  contributionRewards: ContributionRewardsConfig;
  commands: {
    invoice: boolean;
    approve: boolean;
    status: boolean;
    cancel: boolean;
  };
}

export const DEFAULT_LABELS: LabelConfig = {
  requested: 'coinpay:requested',
  pending: 'coinpay:pending',
  approved: 'coinpay:approved',
  paid: 'coinpay:paid',
  expired: 'coinpay:expired',
  cancelled: 'coinpay:cancelled',
  error: 'coinpay:error',
};

export const DEFAULT_GITHUB_INVOICES: GithubInvoiceConfig = {
  enabled: false,
  pdfEnabled: false,
  maxAmountUsd: 1000,
  repositoryHourlyCap: 20,
};

export const DEFAULT_CONTRIBUTION_REWARDS: ContributionRewardsConfig = {
  enabled: false,
  rateUsd: '0.001',
  payment: 'manual',
};

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  defaultCrypto: 'usdc_pol',
  defaultFiat: 'USD',
  minRoleToCreateInvoice: 'collaborator',
  requireApprovalForNonMaintainers: true,
  labels: { ...DEFAULT_LABELS },
  githubInvoices: { ...DEFAULT_GITHUB_INVOICES },
  contributionRewards: { ...DEFAULT_CONTRIBUTION_REWARDS },
  commands: { invoice: true, approve: true, status: true, cancel: true },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function resolveDefaultCrypto(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CONFIG.defaultCrypto;
  const normalized = value.trim().toLowerCase();
  return SUPPORTED_CRYPTO.has(normalized)
    ? normalized
    : DEFAULT_CONFIG.defaultCrypto;
}

/**
 * Money movement gates fail closed: the flag enables only on a literal boolean
 * `true`, and out-of-range or non-numeric limits fall back to the defaults
 * rather than widening. The cap mirrors the API's accepted range (1-1000).
 */
function resolveGithubInvoices(value: unknown): GithubInvoiceConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const maxAmountUsd = isCanonicalUsdAmount(raw['maxAmountUsd'])
    ? raw['maxAmountUsd']
    : DEFAULT_GITHUB_INVOICES.maxAmountUsd;
  const cap = raw['repositoryHourlyCap'];
  const repositoryHourlyCap =
    typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 1 && cap <= 1000
      ? cap
      : DEFAULT_GITHUB_INVOICES.repositoryHourlyCap;
  return { enabled: raw['enabled'] === true, pdfEnabled: raw['pdfEnabled'] === true, maxAmountUsd, repositoryHourlyCap };
}

function resolveContributionRewards(value: unknown): ContributionRewardsConfig {
  if (value === undefined) return { ...DEFAULT_CONTRIBUTION_REWARDS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('contributionRewards requires enabled, rateUsd and payment.');
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'enabled,payment,rateUsd' ||
      typeof raw['enabled'] !== 'boolean' || raw['rateUsd'] !== '0.001' || raw['payment'] !== 'manual') {
    throw new Error("contributionRewards requires boolean enabled, rateUsd: '0.001', payment: 'manual'.");
  }
  return { enabled: raw['enabled'], rateUsd: '0.001', payment: 'manual' };
}

/** Merge a partial (e.g. parsed YAML) over the product defaults. */
export function resolveConfig(partial?: DeepPartial<ResolvedConfig> | null): ResolvedConfig {
  if (!partial) {
    return {
      ...DEFAULT_CONFIG,
      labels: { ...DEFAULT_LABELS },
      githubInvoices: { ...DEFAULT_GITHUB_INVOICES },
      contributionRewards: { ...DEFAULT_CONTRIBUTION_REWARDS },
    };
  }
  return {
    enabled: partial.enabled ?? DEFAULT_CONFIG.enabled,
    defaultCrypto: resolveDefaultCrypto(partial.defaultCrypto),
    defaultFiat: partial.defaultFiat ?? DEFAULT_CONFIG.defaultFiat,
    minRoleToCreateInvoice: partial.minRoleToCreateInvoice ?? DEFAULT_CONFIG.minRoleToCreateInvoice,
    requireApprovalForNonMaintainers:
      partial.requireApprovalForNonMaintainers ?? DEFAULT_CONFIG.requireApprovalForNonMaintainers,
    labels: { ...DEFAULT_LABELS, ...(partial.labels ?? {}) },
    githubInvoices: resolveGithubInvoices(partial.githubInvoices),
    contributionRewards: resolveContributionRewards(partial.contributionRewards),
    commands: { ...DEFAULT_CONFIG.commands, ...(partial.commands ?? {}) },
  };
}
