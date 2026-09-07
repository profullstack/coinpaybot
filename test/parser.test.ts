import { describe, it, expect } from 'vitest';
import {
  extractCommandLine,
  isCanonicalUsdAmount,
  parseCommand,
  tokenize,
} from '../src/parser.js';

describe('tokenize', () => {
  it('honors double and single quotes', () => {
    expect(tokenize('/coinpay invoice 250 USD --for "Milestone 1: x"')).toEqual([
      '/coinpay', 'invoice', '250', 'USD', '--for', 'Milestone 1: x',
    ]);
    expect(tokenize("/coinpay invoice 10 --for 'a b'")).toEqual([
      '/coinpay', 'invoice', '10', '--for', 'a b',
    ]);
  });
});

describe('extractCommandLine', () => {
  it('finds the command line among prose', () => {
    const body = 'Sounds good.\n\n/coinpay invoice 250 USD --crypto usdc_pol\n\nthanks';
    expect(extractCommandLine(body)).toBe('/coinpay invoice 250 USD --crypto usdc_pol');
  });
  it('ignores the command mentioned inline in backticks', () => {
    expect(extractCommandLine('use `/coinpay invoice` to bill')).toBeNull();
  });
  it('returns null when absent', () => {
    expect(extractCommandLine('no command here')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('parses a full invoice command', () => {
    const r = parseCommand('/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1" --due 14d --wallet 0xabc');
    expect(r).toMatchObject({
      kind: 'invoice', amount: 250, fiat: 'USD', crypto: 'usdc_pol',
      source: 'invoice',
      description: 'Milestone 1', due: '14d', wallet: '0xabc',
    });
  });

  it('parses a PR-backed create command with dollar syntax and dry-run', () => {
    expect(
      parseCommand('/coinpay create $10 USD --wallet 0xabc --crypto usdc_base --dry-run'),
    ).toMatchObject({
      kind: 'invoice',
      source: 'create',
      amount: 10,
      fiat: 'USD',
      crypto: 'usdc_base',
      wallet: '0xabc',
      dryRun: true,
    });
  });

  it('requires an explicit wallet for create', () => {
    expect(parseCommand('/coinpay create $10 USD')).toMatchObject({
      kind: 'error',
      code: 'missing_wallet',
    });
  });

  it('rejects value flags without values and extra positional arguments', () => {
    expect(parseCommand('/coinpay create $10 USD --wallet')).toMatchObject({
      kind: 'error',
      code: 'missing_flag_value',
    });
    expect(
      parseCommand('/coinpay create $10 USD extra --wallet 0xabc'),
    ).toMatchObject({ kind: 'error', code: 'bad_arguments' });
  });

  it('rejects unsupported fiat and unknown create flags', () => {
    expect(parseCommand('/coinpay create $10 EUR --wallet 0xabc')).toMatchObject({
      kind: 'error',
      code: 'bad_fiat',
    });
    expect(
      parseCommand('/coinpay create $10 USD --wallet 0xabc --for nope'),
    ).toMatchObject({ kind: 'error', code: 'unknown_flag' });
  });

  it('defaults fiat to USD and leaves crypto unset for config default', () => {
    const r = parseCommand('/coinpay invoice 99');
    expect(r).toMatchObject({ kind: 'invoice', amount: 99, fiat: 'USD' });
    expect((r as any).crypto).toBeUndefined();
  });

  it('rejects a non-positive amount', () => {
    expect(parseCommand('/coinpay invoice -5')).toMatchObject({ kind: 'error', code: 'bad_amount' });
    expect(parseCommand('/coinpay invoice abc')).toMatchObject({ kind: 'error', code: 'bad_amount' });
  });

  it.each([
    '$0x64',
    '$1e3',
    '0o17',
    '0b101',
    '+10',
    '1e-7',
    '.50',
    '1.',
    '1.001',
    '1000000000',
  ])('rejects non-decimal or over-precise amount %s', (amount) => {
    expect(parseCommand(`/coinpay invoice ${amount}`)).toMatchObject({
      kind: 'error',
      code: 'bad_amount',
    });
  });

  it.each(['0.01', '$10', '10.5', '999999999.99'])(
    'accepts canonical decimal amount %s',
    (amount) => {
      expect(parseCommand(`/coinpay invoice ${amount}`)).toMatchObject({
        kind: 'invoice',
      });
    },
  );

  it('rejects a missing amount', () => {
    expect(parseCommand('/coinpay invoice')).toMatchObject({ kind: 'error', code: 'missing_amount' });
  });

  it('rejects an unsupported crypto', () => {
    expect(parseCommand('/coinpay invoice 10 --crypto doge_moon')).toMatchObject({ kind: 'error', code: 'bad_crypto' });
  });

  it('parses simple subcommands', () => {
    expect(parseCommand('/coinpay help')).toEqual({ kind: 'help' });
    expect(parseCommand('/coinpay approve')).toEqual({ kind: 'approve' });
    expect(parseCommand('/coinpay status')).toEqual({ kind: 'status' });
    expect(parseCommand('/coinpay cancel')).toEqual({ kind: 'cancel' });
    expect(parseCommand('/coinpay')).toEqual({ kind: 'help' });
  });

  it('flags unknown subcommands', () => {
    expect(parseCommand('/coinpay frobnicate')).toMatchObject({ kind: 'error', code: 'unknown_subcommand' });
  });

  it('returns not_a_command when no command present', () => {
    expect(parseCommand('just chatting')).toMatchObject({ kind: 'error', code: 'not_a_command' });
  });
});

describe('parseCommand — publish-invoice grammar (@payer first argument)', () => {
  it('parses the canonical form', () => {
    expect(parseCommand('/coinpay create @octocat 25 "Fix the settlement race"')).toEqual({
      kind: 'publish_invoice',
      payer: 'octocat',
      amount: 25,
      fiat: 'USD',
      description: 'Fix the settlement race',
      dryRun: false,
    });
  });

  it('accepts the optional $ prefix, literal USD, and --dry-run', () => {
    expect(
      parseCommand('/coinpay create @octocat $10.50 USD "Milestone 1" --dry-run'),
    ).toEqual({
      kind: 'publish_invoice',
      payer: 'octocat',
      amount: 10.5,
      fiat: 'USD',
      description: 'Milestone 1',
      dryRun: true,
    });
  });

  it('keeps a numeric first argument on the legacy create flow', () => {
    expect(parseCommand('/coinpay create $10 USD --wallet 0xabc')).toMatchObject({
      kind: 'invoice',
      source: 'create',
      amount: 10,
      wallet: '0xabc',
    });
  });

  it.each([
    '@',
    '@-octocat',
    '@octocat-',
    '@oct$cat',
    '@' + 'a'.repeat(40),
  ])('rejects an invalid payer login %s', (payer) => {
    expect(parseCommand(`/coinpay create ${payer} 10 "x"`)).toMatchObject({
      kind: 'error',
      code: 'bad_payer',
      flow: 'publish_invoice',
    });
  });

  it.each(['-5', 'abc', '1.001', '1e3', '1000000000', '0'])(
    'rejects a non-canonical amount %s',
    (amount) => {
      expect(parseCommand(`/coinpay create @octocat ${amount} "x"`)).toMatchObject({
        kind: 'error',
        code: 'bad_amount',
      });
    },
  );

  it('rejects non-USD fiat and missing pieces', () => {
    expect(parseCommand('/coinpay create @octocat 10 EUR "x"')).toMatchObject({
      kind: 'error',
      code: 'bad_fiat',
    });
    expect(parseCommand('/coinpay create @octocat')).toMatchObject({
      kind: 'error',
      code: 'missing_amount',
    });
    expect(parseCommand('/coinpay create @octocat 10')).toMatchObject({
      kind: 'error',
      code: 'missing_description',
    });
    expect(parseCommand('/coinpay create @octocat 10 USD')).toMatchObject({
      kind: 'error',
      code: 'missing_description',
    });
  });

  it('requires the description to be quoted', () => {
    expect(parseCommand('/coinpay create @octocat 10 fix-bug')).toMatchObject({
      kind: 'error',
      code: 'bad_description',
    });
  });

  it('treats a quoted "USD" as a description, not fiat', () => {
    expect(parseCommand('/coinpay create @octocat 10 "USD"')).toMatchObject({
      kind: 'publish_invoice',
      description: 'USD',
    });
  });

  it('rejects sneaked flags — wallet, crypto, anything but --dry-run', () => {
    for (const flag of ['--wallet 0xattacker', '--crypto btc', '--for x', '--to y', '--client z']) {
      expect(parseCommand(`/coinpay create @octocat 10 "x" ${flag}`)).toMatchObject({
        kind: 'error',
        code: 'unknown_flag',
        flow: 'publish_invoice',
      });
    }
  });

  it('rejects trailing arguments after the description', () => {
    expect(parseCommand('/coinpay create @octocat 10 "x" extra')).toMatchObject({
      kind: 'error',
      code: 'bad_arguments',
    });
  });

  it('treats a quoted "--dry-run" as data, not a flag', () => {
    expect(parseCommand('/coinpay create @octocat 10 "--dry-run"')).toEqual({
      kind: 'publish_invoice',
      payer: 'octocat',
      amount: 10,
      fiat: 'USD',
      description: '--dry-run',
      dryRun: false,
    });
  });

  it('sanitizes the description deterministically: control chars and runs of space', () => {
    expect(
      parseCommand('/coinpay create @octocat 10 "a\tb\u0000c   d"'),
    ).toMatchObject({ kind: 'publish_invoice', description: 'a b c d' });
  });
  it.each([
    '/coinpay create @bad`@victim 10 "x"',
    '/coinpay create @payer bad`@victim "x"',
    '/coinpay create @payer 10 "x" --bad`@victim',
    '/coinpay create @payer 10 "x" unexpected`@victim',
  ])('does not echo hostile input in public parse errors: %s', (command) => {
    const result = parseCommand(command);
    expect(result).toMatchObject({kind: 'error', flow: 'publish_invoice'});
    if (result.kind === 'error') expect(result.message).not.toContain('@victim');
  });

  it('bounds the description and rejects blank text', () => {
    expect(
      parseCommand(`/coinpay create @octocat 10 "${'a'.repeat(201)}"`),
    ).toMatchObject({ kind: 'error', code: 'bad_description' });
    expect(
      parseCommand(`/coinpay create @octocat 10 "${'a'.repeat(200)}"`),
    ).toMatchObject({ kind: 'publish_invoice' });
    expect(parseCommand('/coinpay create @octocat 10 "   "')).toMatchObject({
      kind: 'error',
      code: 'bad_description',
    });
  });
});

describe('isCanonicalUsdAmount', () => {
  it.each([0.01, 10, 10.5, 999_999_999.99])(
    'accepts a canonical marker amount %s',
    (amount) => expect(isCanonicalUsdAmount(amount)).toBe(true),
  );

  it.each([0, -1, 1.001, 1e-7, 1_000_000_000, Number.NaN, Infinity])(
    'rejects a marker amount outside the command grammar %s',
    (amount) => expect(isCanonicalUsdAmount(amount)).toBe(false),
  );
});
