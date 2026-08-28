import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js';

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
