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
 * Valid GitHub login: 1-39 alphanumeric/hyphen characters that start and end
 * alphanumeric. Matches the validation CoinPayPortal applies to
 * `source_reference` logins, so anything we accept the API accepts too.
 */
const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export function isValidGithubLogin(value: string): boolean {
  return GITHUB_LOGIN_RE.test(value);
}

/** Hard bound on the free-text description of a GitHub-published invoice. */
export const MAX_INVOICE_DESCRIPTION_LENGTH = 200;

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

/**
 * `/coinpay create @payer <amount> ["USD"] "<description>" [--dry-run]`
 *
 * Publishes a CoinPayPortal invoice issued by the REPOSITORY-CONFIGURED
 * business (never the commenter's own CoinPay account — no account mapping
 * exists). `payer` is only a GitHub mention, not a verified CoinPay client.
 */
export interface PublishInvoiceCommand {
  kind: 'publish_invoice';
  /** GitHub login of the mentioned payer, without the leading `@`. */
  payer: string;
  amount: number;
  fiat: 'USD';
  /** Sanitized plain text: control chars stripped, whitespace collapsed. */
  description: string;
  dryRun: boolean;
}

export interface SimpleCommand {
  kind: 'help' | 'approve' | 'status' | 'cancel';
}

export type ParsedCommand = InvoiceCommand | PublishInvoiceCommand | SimpleCommand;

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
    | 'missing_wallet'
    | 'bad_payer'
    | 'missing_description'
    | 'bad_description';
  message: string;
  /** Set when the error came from the `@payer` invoice grammar, so the
   *  handler can apply that flow's rules (e.g. never reply to bots). */
  flow?: 'publish_invoice';
}

export type ParseResult = ParsedCommand | ParseError;

export interface CommandToken {
  text: string;
  /** True when the token came from a quoted span — never a flag then. */
  quoted: boolean;
}

/**
 * Split a command line into tokens, honoring single/double quoted spans, and
 * remember which tokens were quoted so grammar rules can require literal text.
 */
export function tokenizeDetailed(line: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push({ text: m[1] ?? m[2] ?? m[3] ?? '', quoted: m[3] === undefined });
  }
  return tokens;
}

/** Split a command line into tokens, honoring single/double quoted spans. */
export function tokenize(line: string): string[] {
  return tokenizeDetailed(line).map((token) => token.text);
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

  const detailed = tokenizeDetailed(line);
  const tokens = detailed.map((token) => token.text);
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
      // The first argument selects the flow: `@payer` publishes a CoinPay
      // invoice; anything else keeps the legacy numeric-first payment grammar.
      if (detailed[2]?.text.startsWith('@')) {
        return parsePublishInvoice(detailed.slice(2));
      }
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

const PUBLISH_INVOICE_USAGE =
  'Example: `/coinpay create @payer 25 "Fix the settlement race"`';

/**
 * Sanitize untrusted free text into stable, bounded plain text: control
 * characters removed, whitespace collapsed. Deterministic, so the same comment
 * always produces the same invoice notes (which the API hashes for idempotency).
 */
export function sanitizeDescription(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePublishInvoice(args: CommandToken[]): ParseResult {
  const fail = (code: ParseError['code'], message: string): ParseError => ({
    kind: 'error',
    code,
    message,
    flow: 'publish_invoice',
  });

  let dryRun = false;
  const positionals: CommandToken[] = [];
  for (const token of args) {
    // Quoted tokens are always data — a description of `"--dry-run"` is text.
    if (!token.quoted && token.text.startsWith('--')) {
      if (token.text === '--dry-run') {
        dryRun = true;
        continue;
      }
      return fail(
        'unknown_flag',
        `Unsupported flag for \`/coinpay create @payer\`. Only \`--dry-run\` is supported. ${PUBLISH_INVOICE_USAGE}`,
      );
    }
    positionals.push(token);
  }

  const payer = positionals[0]!.text.slice(1);
  if (!GITHUB_LOGIN_RE.test(payer)) {
    return fail(
      'bad_payer',
      `The payer must be a single valid GitHub login mention. ${PUBLISH_INVOICE_USAGE}`,
    );
  }

  const amountToken = positionals[1];
  if (amountToken === undefined) {
    return fail('missing_amount', `Missing amount. ${PUBLISH_INVOICE_USAGE}`);
  }
  const amountText = amountToken.text.startsWith('$')
    ? amountToken.text.slice(1)
    : amountToken.text;
  const amount = Number(amountText);
  if (!USD_AMOUNT_RE.test(amountText) || !Number.isFinite(amount) || amount <= 0) {
    return fail(
      'bad_amount',
      `Invalid amount. Use a positive decimal USD amount with at most two decimal places. ${PUBLISH_INVOICE_USAGE}`,
    );
  }

  // Optional bare fiat token between amount and description; USD only.
  let next = 2;
  const fiatCandidate = positionals[next];
  if (
    fiatCandidate !== undefined &&
    !fiatCandidate.quoted &&
    /^[a-z]{3}$/i.test(fiatCandidate.text)
  ) {
    if (fiatCandidate.text.toUpperCase() !== 'USD') {
      return fail(
        'bad_fiat',
        `Unsupported fiat \`${fiatCandidate.text.toUpperCase()}\`. CoinPay GitHub invoices currently support USD only.`,
      );
    }
    next += 1;
  }

  const descriptionToken = positionals[next];
  if (descriptionToken === undefined) {
    return fail('missing_description', `Missing description. ${PUBLISH_INVOICE_USAGE}`);
  }
  if (!descriptionToken.quoted) {
    return fail('bad_description', `Wrap the description in quotes. ${PUBLISH_INVOICE_USAGE}`);
  }
  if (positionals.length > next + 1) {
    return fail(
      'bad_arguments',
      `Unexpected extra argument. ${PUBLISH_INVOICE_USAGE}`,
    );
  }
  const description = sanitizeDescription(descriptionToken.text);
  if (description.length === 0) {
    return fail('bad_description', `The description must contain visible text. ${PUBLISH_INVOICE_USAGE}`);
  }
  if (description.length > MAX_INVOICE_DESCRIPTION_LENGTH) {
    return fail(
      'bad_description',
      `The description is limited to ${MAX_INVOICE_DESCRIPTION_LENGTH} characters.`,
    );
  }

  return { kind: 'publish_invoice', payer, amount, fiat: 'USD', description, dryRun };
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
