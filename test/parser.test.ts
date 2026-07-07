import { describe, it, expect } from 'vitest';
import { parseCommand, tokenize, extractCommandLine } from '../src/parser.js';

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
      description: 'Milestone 1', due: '14d', wallet: '0xabc',
    });
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
