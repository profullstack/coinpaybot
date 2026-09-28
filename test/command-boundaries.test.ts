import { describe, expect, it } from 'vitest';
import { extractCommandLine, parseCommand } from '../src/parser.js';
import { handleComment, type CommentEvent, type HandlerDeps } from '../src/handler.js';

const commands = [
  '/coinpay create @payer 10 "Review"',
  '/coinpay create 10 --wallet example',
  '/coinpay invoice 10',
  '/coinpay approve',
  '/coinpay cancel',
  '/coinpay status',
];
const examples: Record<string, (command: string) => string> = {
  fence: c => `\`\`\`text\n${c}\n\`\`\``,
  tilde: c => `~~~\n${c}\n~~~`,
  unclosed: c => `\`\`\`\n${c}`,
  indent: c => `    ${c}`,
  quote: c => `> Example\n${c}`,
  list: c => `- Example\n${c}`,
  html: c => `<div>\n${c}\n</div>`,
  details: c => `<details><summary>Examples</summary>\n\n${c}\n\n</details>`,
  htmlGap: c => `<div>\n\n${c}\n\n</div>`,
  comment: c => `<!--\n${c}\n-->`,
  inline: c => `\`Example\n${c}\n\``,
  emphasis: c => `*Example\n${c}\nend*`,
  deleted: c => `~~Example\n${c}\nend~~`,
  link: c => `[Example\n${c}\n](https://example.com)`,
  heading: c => `${c}\n---`,
  escaped: c => `\\${c}`,
  table: c => `Example | Command\n--- | ---\n${c} | text`,
  footnote: c => `[^example]:\n    ${c}`,
};

describe.each(commands)('Markdown command boundary: %s', command => {
  it.each(Object.entries(examples))('ignores %s without touching any dependency', async (_name, wrap) => {
    const body = wrap(command);
    expect(extractCommandLine(body)).toBeNull();
    expect(parseCommand(body)).toMatchObject({ code: 'not_a_command' });
    const deps = new Proxy({} as HandlerDeps, {
      get() { throw new Error('An example must not access configuration, GitHub or CoinPay'); },
    });
    expect(await handleComment({ body } as CommentEvent, deps)).toEqual({ action: 'skipped' });
  });
  it.each(['', 'Some context\n', 'Some context\n\n', '   '])('accepts a plain command after %j', prefix => {
    expect(extractCommandLine(`${prefix}${command}`)).toBe(command);
  });
});

it('uses the first live command, ignoring earlier examples', () => {
  expect(extractCommandLine('```\n/coinpay cancel\n```\n\n/coinpay help\n/coinpay approve')).toBe('/coinpay help');
});
it('preserves raw descriptions and CRLF', () => {
  const command = '/coinpay create @payer 10 "**Bold** and `code`"';
  expect(extractCommandLine(`Notes\r\n\r\n${command}\r\n`)).toBe(command);
});
it('does not broaden the command separator grammar', () => {
  expect(extractCommandLine('/coinpay\tapprove')).toBeNull();
  expect(extractCommandLine('/coinpayment approve')).toBeNull();
});
it('does not fold carriage-return continuation flags into a command', () => {
  expect(extractCommandLine('/coinpay create 10 --wallet A\r--wallet B')).toBe('/coinpay create 10 --wallet A');
  expect(extractCommandLine('```\r/coinpay approve\r```')).toBeNull();
});
it.each(['\u00a0', '\ufeff', '\f', '\u2000', '\u3000'])('ignores non-Markdown indentation %j', space => {
  expect(extractCommandLine(`${space}/coinpay approve`)).toBeNull();
});
it.each(['\v', '\f', '\u00a0', '\u1680', ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)), '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'])('rejects ambiguous separator %j', newline => {
  expect(extractCommandLine(`/coinpay create 10 --wallet A${newline}--wallet B`)).toBeNull();
});
it('rejects a comment above 65536 UTF-16 code units before parsing', () => {
  const command = '/coinpay approve';
  expect(extractCommandLine('x'.repeat(65536) + '\n\n' + command)).toBeNull();
  expect(extractCommandLine('x'.repeat(65536 - command.length - 2) + '\n\n' + command)).toBe(command);
});
it.each(['\u00a0', '\u200b', '\u200c', '\u200d', '\u2060', '\u00ad', '\u180e', '\u202e', '\u2066', '\u0000', '\u007f'])('rejects an ambiguous active command without falling through: %j', control => {
  expect(extractCommandLine(`/coinpay create 10 --wallet A${control}B\n/coinpay approve`)).toBeNull();
});
it('does not guess whether mixed HTML is hidden by the GitHub renderer', () => {
  expect(extractCommandLine('<details>\n\n/coinpay cancel\n\n</details>\n\n/coinpay approve')).toBeNull();
  expect(extractCommandLine('/coinpay approve\n\n<!-- comment metadata -->')).toBeNull();
});
it('ignores HTML hidden inside a quoted description without accessing dependencies', async () => {
  const deps = new Proxy({} as HandlerDeps, {
    get() { throw new Error('HTML input must not touch any dependency'); },
  });
  const body = '/coinpay create @payer 10 "pay <!-- hidden marker -->"';
  expect(await handleComment({ body } as CommentEvent, deps)).toEqual({ action: 'skipped' });
});
it('still accepts a live command after an inert code example with control characters', () => {
  expect(extractCommandLine('\x60\x60\x60\n/coinpay cancel\u00a0\n\x60\x60\x60\n\n/coinpay approve')).toBe('/coinpay approve');
});
