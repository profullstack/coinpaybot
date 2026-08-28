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

const USD_AMOUNT_RE = /^\d{1,9}(?:\.\d{1,2})?$/;

/**
 * Validate the numeric representation recovered from a trusted state marker.
 * Parsing JSON loses the command's original token, so convert back to the
 * canonical decimal form and apply the same bounds as the command parser.
 */
export function isCanonicalUsdAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    USD_AMOUNT_RE.test(String(value))
  );
}

export type Subcommand = 'help' | 'create' | 'invoice' | 'approve' | 'status' | 'cancel';

export interface InvoiceCommand {
  kind: 'invoice';
  source: 'create' | 'invoice';
  amount: number;
  /** Fiat is USD-only for MVP (PRD §8.1, v0.2). Retained for forward-compat. */
  fiat: string;
  crypto?: string;
  description?: string;
  due?: string;
  to?: string;
  wallet?: string;
  dryRun?: boolean;
}

export interface SimpleCommand {
  kind: 'help' | 'approve' | 'status' | 'cancel';
}

export type ParsedCommand = InvoiceCommand | SimpleCommand;

export interface ParseError {
  kind: 'error';
  code:
    | 'not_a_command'
    | 'unknown_subcommand'
    | 'unknown_flag'
    | 'missing_flag_value'
    | 'bad_arguments'
    | 'bad_amount'
    | 'bad_fiat'
    | 'bad_crypto'
    | 'missing_amount'
    | 'missing_wallet';
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

function parseFlags(tokens: string[], booleanFlags = new Set<string>()): {
  positionals: string[];
  flags: Record<string, string>;
  missingValueFlags: string[];
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const missingValueFlags: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (booleanFlags.has(key)) {
        flags[key] = 'true';
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        missingValueFlags.push(key);
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags, missingValueFlags };
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
    case 'create':
      return parseInvoice(tokens.slice(2), 'create');
    case 'invoice':
      return parseInvoice(tokens.slice(2), 'invoice');
    default:
      return {
        kind: 'error',
        code: 'unknown_subcommand',
        message: `Unknown subcommand \`${tokens[1]}\`. Try \`/coinpay help\`.`,
      };
  }
}

function parseInvoice(
  args: string[],
  source: InvoiceCommand['source'],
): ParseResult {
  const { positionals, flags, missingValueFlags } = parseFlags(
    args,
    new Set(['dry-run']),
  );
  const allowedFlags = source === 'create'
    ? new Set(['crypto', 'wallet', 'dry-run'])
    : new Set(['crypto', 'for', 'due', 'to', 'wallet']);
  const unknownFlag = [...Object.keys(flags), ...missingValueFlags].find(
    (flag) => !allowedFlags.has(flag),
  );
  if (unknownFlag) {
    return {
      kind: 'error',
      code: 'unknown_flag',
      message: `Unknown flag \`--${unknownFlag}\` for \`/coinpay ${source}\`.`,
    };
  }
  if (missingValueFlags.length > 0) {
    return {
      kind: 'error',
      code: 'missing_flag_value',
      message: `Flag \`--${missingValueFlags[0]}\` requires a value.`,
    };
  }

  if (positionals.length === 0) {
    return { kind: 'error', code: 'missing_amount', message: 'Missing amount. Example: `/coinpay invoice 250 USD --crypto usdc_pol --for "Milestone 1"`' };
  }
  if (positionals.length > 2) {
    return {
      kind: 'error',
      code: 'bad_arguments',
      message: `Unexpected positional argument \`${positionals[2]}\`.`,
    };
  }

  const amountToken = positionals[0]!.startsWith('$')
    ? positionals[0]!.slice(1)
    : positionals[0]!;
  if (!USD_AMOUNT_RE.test(amountToken)) {
    return {
      kind: 'error',
      code: 'bad_amount',
      message: `Invalid amount \`${positionals[0]}\`. Use a positive decimal USD amount with at most two decimal places.`,
    };
  }
  const amount = Number(amountToken);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      kind: 'error',
      code: 'bad_amount',
      message: `Invalid amount \`${positionals[0]}\`. Use a positive decimal USD amount with at most two decimal places.`,
    };
  }

  // Optional second positional is the fiat currency; USD-only for MVP.
  const fiat = (positionals[1] ?? 'USD').toUpperCase();
  if (fiat !== 'USD') {
    return {
      kind: 'error',
      code: 'bad_fiat',
      message: `Unsupported fiat \`${fiat}\`. CoinPay GitHub invoices currently support USD only.`,
    };
  }

  const crypto = flags['crypto']?.toLowerCase();
  if (crypto !== undefined && !SUPPORTED_CRYPTO.has(crypto)) {
    return { kind: 'error', code: 'bad_crypto', message: `Unsupported crypto \`${crypto}\`. Supported: ${[...SUPPORTED_CRYPTO].join(', ')}.` };
  }

  const cmd: InvoiceCommand = {
    kind: 'invoice',
    source,
    amount,
    fiat,
  };
  if (crypto) cmd.crypto = crypto;
  if (flags['for']) cmd.description = flags['for'];
  if (flags['due']) cmd.due = flags['due'];
  if (flags['to']) cmd.to = flags['to'];
  if (flags['wallet']?.trim()) cmd.wallet = flags['wallet'].trim();
  if (source === 'create' && !cmd.wallet) {
    return {
      kind: 'error',
      code: 'missing_wallet',
      message: 'Missing receiving wallet. Use `--wallet <address>`.',
    };
  }
  if (flags['dry-run'] === 'true') cmd.dryRun = true;
  return cmd;
}
