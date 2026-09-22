import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const mode of [
  'sent',
  'paid',
  'private',
  'forged',
  'replay',
  'disabled',
  'no-pdf',
  'with-rewards',
  'timeout-body',
  'timeout-late',
]) {
  test(`built Action invoice status: ${mode}, no real network`, () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'coinpay-status-bundle-'),
    );
    try {
      fs.writeFileSync(
        path.join(directory, 'event.json'),
        JSON.stringify({
          action: 'created',
          repository: { id: 123 },
          issue: {
            number: 42,
            pull_request: {},
            html_url: 'https://github.com/acme/project/pull/42',
          },
          comment: {
            id: 200,
            body: '/coinpay status',
            user: { id: 8, login: 'author', type: 'User' },
          },
        }),
      );
      fs.writeFileSync(path.join(directory, 'output'), '');
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          new URL('./status-bundle-fixture.mjs', import.meta.url).pathname,
          new URL('../dist/index.js', import.meta.url).pathname,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            GITHUB_REPOSITORY: 'acme/project',
            GITHUB_EVENT_NAME: 'issue_comment',
            GITHUB_EVENT_PATH: path.join(directory, 'event.json'),
            GITHUB_OUTPUT: path.join(directory, 'output'),
            'INPUT_GITHUB-TOKEN': 'fixture-github',
            'INPUT_COINPAY-API-KEY': 'fixture-scoped-key',
            'INPUT_COINPAY-BUSINESS-ID': 'fixture-business',
            BUNDLE_SCENARIO: mode,
            BUNDLE_RESULT: path.join(directory, 'result.json'),
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(
        fs.readFileSync(path.join(directory, 'result.json'), 'utf8'),
      );
      assert.equal(report.passed, true, JSON.stringify(report));
      assert.ok(!result.stdout.includes('PRIVATE_SENTINEL'));
      const action =
        mode === 'replay'
          ? 'noop_duplicate'
          : mode === 'disabled'
            ? 'noop_disabled'
            : 'status';
      assert.ok(
        fs
          .readFileSync(path.join(directory, 'output'), 'utf8')
          .includes(action),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
