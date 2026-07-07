/**
 * Parses `/coinpay ...` commands from GitHub comment bodies (PRD §8).
 *
 * The parser is pure and deterministic — no I/O — so it is exhaustively unit
 * tested. It never throws on bad input; it returns a typed error result the
 * caller turns into a friendly usage comment.
 */

export const SUPPORTED_CRYPTO = new Set([
  'btc', 'bch', 'eth', 'pol', 'sol', 'doge', 'xrp', 'ada', 'bnb',
  'usdt', 'usdt_eth', 'usdt_pol', 'usdt_sol',
  'usdc', 'usdc_eth', 'usdc_pol', 'usdc_sol', 'usdc_base',
]);

export type Subcommand = 'help' | 'invoice' | 'approve' | 'status' | 'cancel';

export interface InvoiceCommand {
  kind: 'invoice';
  amount: number;
  /** Fiat is USD-only for MVP (PRD §8.1, v0.2). Retained for forward-compat. */
  fiat: string;
  crypto?: string;
  description?: string;
  due?: string;
  to?: string;
  wallet?: string;
}

export interface SimpleCommand {
  kind: 'help' | 'approve' | 'status' | 'cancel';
}

export type ParsedCommand = InvoiceCommand | SimpleCommand;

export interface ParseError {
  kind: 'error';
  code: 'not_a_command' | 'unknown_subcommand' | 'bad_amount' | 'bad_crypto' | 'missing_amount';
  message: string;
}

export type ParseResult = ParsedCommand | ParseError;

/** Split a command line into tokens, honoring single/double quoted spans. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

/**
 * Returns the first `/coinpay ...` line found in a comment body, or null.
 * Only a line whose first non-space token is exactly `/coinpay` qualifies,
 * so prose mentioning the command in backticks does not trigger it.
 */
export function extractCommandLine(body: string): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '/coinpay' || line.startsWith('/coinpay ')) return line;
  }
  return null;
}

function parseFlags(tokens: string[]): {
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

export function parseCommand(body: string): ParseResult {
  const line = extractCommandLine(body);
  if (line === null) {
    return { kind: 'error', code: 'not_a_command', message: 'No /coinpay command found.' };
  }

  const tokens = tokenize(line);
  const sub = (tokens[1] ?? 'help').toLowerCase() as Subcommand;

  switch (sub) {
    case 'help':
      return { kind: 'help' };
    case 'approve':
      return { kind: 'approve' };
    case 'status':
      return { kind: 'status' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'invoice':
      return parseInvoice(tokens.slice(2));
    default:
      return {
        kind: 'error',
        code: 'unknown_subcommand',
        message: `Unknown subcommand \`${tokens[1]}\`. Try \`/coinpay help\`.`,
      };
  }
}

function parseInvoice(args: string[]): ParseResult {
  const { positionals, flags } = parseFlags(args);

  if (positionals.length === 0) {
    return { kind: 'error', code: 'missing_amount', message: 'Missing amount. Example: `/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"`' };
  }

  const amount = Number(positionals[0]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { kind: 'error', code: 'bad_amount', message: `Invalid amount \`${positionals[0]}\`. Amount must be a positive number of USD.` };
  }

  // Optional second positional is the fiat currency; USD-only for MVP.
  const fiat = (positionals[1] ?? 'USD').toUpperCase();

  const crypto = flags['crypto']?.toLowerCase();
  if (crypto !== undefined && !SUPPORTED_CRYPTO.has(crypto)) {
    return { kind: 'error', code: 'bad_crypto', message: `Unsupported crypto \`${crypto}\`. Supported: ${[...SUPPORTED_CRYPTO].join(', ')}.` };
  }

  const cmd: InvoiceCommand = {
    kind: 'invoice',
    amount,
    fiat,
  };
  if (crypto) cmd.crypto = crypto;
  if (flags['for']) cmd.description = flags['for'];
  if (flags['due']) cmd.due = flags['due'];
  if (flags['to']) cmd.to = flags['to'];
  if (flags['wallet']) cmd.wallet = flags['wallet'];
  return cmd;
}
