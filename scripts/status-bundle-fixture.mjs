// Load before dist/index.js: fake transports, no real network or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.BUNDLE_SCENARIO;
const id = '3f9c1e00-0000-4000-8000-000000000001';
const calls = [],
  comments = [];
let bodyCancels = 0,
  bodyReaders = 0;
const deny = () => {
  throw new Error('Real network disabled in status bundle fixture');
};
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
syncBuiltinESMExports();
const marker = `<!-- coinpay:invoice:v1 ${Buffer.from(
  JSON.stringify({
    invoiceId: id,
    repositoryId: 123,
    threadNumber: 42,
    commentId: 100,
  }),
).toString('base64url')} -->`;

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = options.method || 'GET';
  calls.push({ host: url.host, path: url.pathname, method });
  let data;
  if (url.host === 'coinpayportal.com') {
    assert.equal(method, 'GET');
    assert.equal(url.pathname, `/api/invoices/${id}`);
    assert.equal(options.headers.Authorization, 'Bearer fixture-scoped-key');
    assert.equal(options.redirect, 'error');
    if (mode === 'timeout-body' || mode === 'timeout-late') {
      // Deliberately ignore AbortSignal to test the shipped bundle's cleanup.
      if (mode === 'timeout-late')
        await new Promise((resolve) => setTimeout(resolve, 11000));
      const stream = new ReadableStream({
        cancel: () => {
          bodyCancels++;
        },
      });
      const getReader = stream.getReader.bind(stream);
      stream.getReader = (...args) => {
        bodyReaders++;
        return getReader(...args);
      };
      return new Response(stream);
    }
    data = {
      success: true,
      invoice: {
        id,
        business_id: 'fixture-business',
        currency: 'USD',
        amount: '10.00',
        invoice_number: 'INV-1',
        status:
          mode === 'private' ? 'draft' : mode === 'paid' ? 'paid' : 'sent',
        created_at: '2026-09-20T10:00:00Z',
        metadata: {
          source_reference: {
            provider: 'github',
            repository: 'acme/project',
            thread_number: 42,
            comment_id: 100,
            actor_id: 8,
          },
        },
        clients: { email: 'PRIVATE_SENTINEL' },
        merchant_wallet_address: 'PRIVATE_SENTINEL',
      },
    };
  } else {
    assert.equal(url.host, 'api.github.com');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/contents/.github/coinpay.yml')) {
      data = {
        encoding: 'base64',
        content: Buffer.from(
          `enabled: true\ncommands:\n  status: ${mode !== 'disabled'}\ngithubInvoices:\n  enabled: true\n  pdfEnabled: ${mode !== 'no-pdf'}\ncontributionRewards:\n  enabled: ${mode === 'with-rewards'}\n  rateUsd: '0.001'\n  payment: manual\n`,
        ).toString('base64'),
      };
    } else if (pathname === '/users/github-actions[bot]')
      data = { id: 77, login: 'github-actions[bot]' };
    else if (pathname.endsWith('/issues/42/comments') && method === 'GET') {
      data = [
        {
          id: 101,
          user: {
            id: mode === 'forged' ? 88 : 77,
            login: 'github-actions[bot]',
            type: 'Bot',
          },
          body:
            marker +
            (mode === 'replay' ? '\n<!-- coinpay:handled 200 -->' : ''),
          created_at: '2026-09-20T10:01:00Z',
        },
      ];
    } else if (pathname.endsWith('/issues/comments/100')) {
      data = {
        id: 100,
        user: { id: 8, type: 'User', login: 'author' },
        issue_url: 'https://api.github.com/repos/acme/project/issues/42',
        created_at: '2026-09-20T10:00:00Z',
      };
    } else if (pathname.endsWith('/issues/42/comments') && method === 'POST') {
      comments.push(JSON.parse(options.body).body);
      data = { id: 201 };
    } else throw new Error(`Unexpected GitHub endpoint: ${pathname}`);
  }
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  });
};
globalThis[Symbol.for('undici.globalDispatcher.1')] = {
  dispatch(options, handler) {
    void (async () => {
      handler.onConnect(() => {});
      let body = options.body;
      if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        body = Buffer.concat(chunks).toString('utf8');
      }
      const response = await globalThis.fetch(
        new URL(options.path, options.origin).href,
        { method: options.method, body },
      );
      handler.onHeaders(
        response.status,
        [Buffer.from('content-type'), Buffer.from('application/json')],
        () => {},
        'OK',
      );
      handler.onData(Buffer.from(await response.text()));
      handler.onComplete([]);
    })().catch((error) => handler.onError(error));
    return true;
  },
  close: async () => {},
  destroy: async () => {},
};
process.on('beforeExit', () => {
  try {
    assert.equal(process.exitCode || 0, 0);
    const finance = calls.filter((call) => call.host === 'coinpayportal.com');
    assert.equal(
      finance.length,
      [
        'sent',
        'paid',
        'private',
        'no-pdf',
        'with-rewards',
        'timeout-body',
        'timeout-late',
      ].includes(mode)
        ? 1
        : 0,
    );
    assert.equal(
      comments.length,
      ['disabled', 'replay'].includes(mode) ? 0 : 1,
    );
    const body = comments.join('\n');
    assert.ok(!body.includes('PRIVATE_SENTINEL'));
    if (['sent', 'paid', 'no-pdf', 'with-rewards'].includes(mode)) {
      assert.ok(body.includes(`/now/${id}`));
      assert.equal(body.includes(`/api/invoices/${id}/pdf`), mode !== 'no-pdf');
      if (mode === 'paid')
        assert.ok(body.includes('does not confirm on-chain settlement'));
    } else assert.ok(!body.includes('/now/'));
    if (mode === 'timeout-body' || mode === 'timeout-late') {
      assert.equal(bodyCancels, 1, 'Timed-out response body must be cancelled');
      assert.equal(bodyReaders, mode === 'timeout-late' ? 0 : 1);
      assert.ok(body.includes('unavailable'));
      assert.ok(!body.includes('/pdf'));
    }
    fs.writeFileSync(
      process.env.BUNDLE_RESULT,
      JSON.stringify({
        passed: true,
        mode,
        reads: finance.length,
        replies: comments.length,
        bodyCancels,
        bodyReaders,
      }),
    );
  } catch (error) {
    process.exitCode = 1;
    fs.writeFileSync(
      process.env.BUNDLE_RESULT,
      JSON.stringify({
        passed: false,
        mode,
        error: error.message,
        calls,
        comments,
      }),
    );
  }
});
