/**
 * Repository configuration (.github/coinpay.yml) merged over product defaults.
 * Config precedence (PRD §15): command args > repo file > product defaults.
 * (Org/app dashboard defaults are a hosted-App concern, not the Action MVP.)
 */

export type MinRole = 'owner' | 'member' | 'collaborator';

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

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  defaultCrypto: 'usdc_pol',
  defaultFiat: 'USD',
  minRoleToCreateInvoice: 'collaborator',
  requireApprovalForNonMaintainers: true,
  labels: { ...DEFAULT_LABELS },
  commands: { invoice: true, approve: true, status: true, cancel: true },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Merge a partial (e.g. parsed YAML) over the product defaults. */
export function resolveConfig(partial?: DeepPartial<ResolvedConfig> | null): ResolvedConfig {
  if (!partial) return { ...DEFAULT_CONFIG, labels: { ...DEFAULT_LABELS } };
  return {
    enabled: partial.enabled ?? DEFAULT_CONFIG.enabled,
    defaultCrypto: partial.defaultCrypto ?? DEFAULT_CONFIG.defaultCrypto,
    defaultFiat: partial.defaultFiat ?? DEFAULT_CONFIG.defaultFiat,
    minRoleToCreateInvoice: partial.minRoleToCreateInvoice ?? DEFAULT_CONFIG.minRoleToCreateInvoice,
    requireApprovalForNonMaintainers:
      partial.requireApprovalForNonMaintainers ?? DEFAULT_CONFIG.requireApprovalForNonMaintainers,
    labels: { ...DEFAULT_LABELS, ...(partial.labels ?? {}) },
    commands: { ...DEFAULT_CONFIG.commands, ...(partial.commands ?? {}) },
  };
}
