import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_GITHUB_INVOICES,
  resolveConfig,
} from '../src/config.js';

describe('resolveConfig — githubInvoices', () => {
  it('defaults to disabled with a 1000 USD cap and hourly cap of 20', () => {
    expect(resolveConfig().githubInvoices).toEqual({
      enabled: false,
      pdfEnabled: false,
      maxAmountUsd: 1000,
      repositoryHourlyCap: 20,
    });
    expect(resolveConfig({}).githubInvoices).toEqual(DEFAULT_GITHUB_INVOICES);
  });

  it('enables only on a literal boolean true', () => {
    expect(resolveConfig({ githubInvoices: { enabled: true } } as never).githubInvoices.enabled).toBe(true);
    for (const enabled of ['true', 'yes', 1, {}, null]) {
      expect(
        resolveConfig({ githubInvoices: { enabled } } as never).githubInvoices.enabled,
      ).toBe(false);
    }
  });

  it('accepts in-range overrides', () => {
    expect(
      resolveConfig({
        githubInvoices: { enabled: true, maxAmountUsd: 50.25, repositoryHourlyCap: 3 },
      } as never).githubInvoices,
    ).toEqual({ enabled: true, pdfEnabled: false, maxAmountUsd: 50.25, repositoryHourlyCap: 3 });
  });

  it('enables PDF links only on literal true', () => {
    expect(resolveConfig({ githubInvoices: { pdfEnabled: true } }).githubInvoices.pdfEnabled).toBe(true);
    for (const value of ['true', 1, {}, null, false]) {
      expect(resolveConfig({ githubInvoices: { pdfEnabled: value } } as never).githubInvoices.pdfEnabled).toBe(false);
    }
  });

  it.each([[0], [-5], [1.001], ['100'], [Number.NaN], [Infinity], [1_000_000_000]])(
    'falls back safely on an invalid maxAmountUsd: %j',
    (maxAmountUsd) => {
      expect(
        resolveConfig({ githubInvoices: { maxAmountUsd } } as never).githubInvoices.maxAmountUsd,
      ).toBe(DEFAULT_GITHUB_INVOICES.maxAmountUsd);
    },
  );

  it.each([[0], [1001], [2.5], ['20'], [-1]])(
    'falls back safely on an out-of-range repositoryHourlyCap: %j',
    (repositoryHourlyCap) => {
      expect(
        resolveConfig({ githubInvoices: { repositoryHourlyCap } } as never).githubInvoices
          .repositoryHourlyCap,
      ).toBe(DEFAULT_GITHUB_INVOICES.repositoryHourlyCap);
    },
  );

  it('tolerates a non-object githubInvoices value', () => {
    expect(resolveConfig({ githubInvoices: 'on' } as never).githubInvoices).toEqual(
      DEFAULT_GITHUB_INVOICES,
    );
  });
});

describe('resolveConfig', () => {
  it('normalizes a supported default crypto', () => {
    expect(resolveConfig({ defaultCrypto: ' USDC_SOL ' }).defaultCrypto).toBe(
      'usdc_sol',
    );
  });

  it.each([['unsupported'], [''], [42]])(
    'falls back safely for an unsupported default crypto: %j',
    (defaultCrypto) => {
      expect(
        resolveConfig({ defaultCrypto } as never).defaultCrypto,
      ).toBe(DEFAULT_CONFIG.defaultCrypto);
    },
  );
});
