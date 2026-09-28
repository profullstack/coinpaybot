import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const body of [
  '```\n/coinpay create @payer 10 "example"\n```',
  '> Example\n/coinpay approve',
  '<!--\n/coinpay cancel\n-->',
  '~~Example\n/coinpay invoice 10\nend~~',
  'x'.repeat(65536) + '\n/coinpay approve',
  '/coinpay settle ' + 'x'.repeat(65536),
]) {
  test(`built Action ignores Markdown example (${body.slice(0, 24)})`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpay-command-'));
    try {
      fs.writeFileSync(path.join(directory, 'event.json'), JSON.stringify({
        action: 'created', issue: { number: 1, pull_request: {} },
        comment: { id: 2, body, user: { login: 'example', type: 'User' } },
      }));
      fs.writeFileSync(path.join(directory, 'output'), '');
      const result = spawnSync(process.execPath, [
        '--import', new URL('./command-bundle-fixture.mjs', import.meta.url).pathname,
        new URL('../dist/index.js', import.meta.url).pathname,
      ], { encoding: 'utf8', timeout: 5000, env: {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: 'example/project', GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: path.join(directory, 'event.json'),
        GITHUB_OUTPUT: path.join(directory, 'output'),
      } });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(fs.readFileSync(path.join(directory, 'output'), 'utf8'), /skipped/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
