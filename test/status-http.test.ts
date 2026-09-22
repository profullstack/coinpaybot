import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CoinPayClient } from '../src/coinpay.js';

const ref = {
  invoiceId: '3f9c1e00-0000-4000-8000-000000000001',
  repositoryId: 123,
  threadNumber: 42,
  commentId: 100,
};
const row = {
  id: ref.invoiceId,
  business_id: 'local-business',
  currency: 'USD',
  amount: '10.00',
  invoice_number: 'INV-local',
  status: 'sent',
  created_at: '2026-09-21T00:00:00Z',
  metadata: {
    source_reference: {
      provider: 'github',
      repository: 'acme/widgets',
      thread_number: 42,
      comment_id: 100,
      actor_id: 5,
    },
  },
  notes: 'PRIVATE_SENTINEL',
  clients: { email: 'PRIVATE_SENTINEL' },
  merchant_wallet_address: 'PRIVATE_SENTINEL',
};

async function expectClosed(closed: Promise<unknown>) {
  expect(closed).toBeDefined();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Response still open after client returned')),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withServer(
  handler: (response: ServerResponse) => void,
  check: (
    client: CoinPayClient,
    requests: {
      method: string | undefined;
      url: string | undefined;
      auth: string | undefined;
    }[],
  ) => Promise<void>,
) {
  const requests: {
    method: string | undefined;
    url: string | undefined;
    auth: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
    });
    handler(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  const client = new CoinPayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'LOCAL_FAKE_KEY',
    businessId: 'local-business',
  });
  try {
    await check(client, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('read-only invoice status over real loopback HTTP', () => {
  it('projects only public fields from a streamed response and makes exactly one GET', async () => {
    await withServer(
      (response) => {
        response.setHeader('content-type', 'application/json');
        const body = Buffer.from(
          JSON.stringify({
            success: true,
            invoice: { ...row, invoice_number: 'INV-\u0111' },
          }),
        );
        for (const byte of body) response.write(Buffer.from([byte]));
        response.end();
      },
      async (client, requests) => {
        const result = await client.getInvoiceStatus(ref, 'acme/widgets');
        expect(result).toEqual({
          ...ref,
          invoiceNumber: 'INV-\u0111',
          status: 'sent',
          amount: 10,
          currency: 'USD',
          actorId: 5,
          createdAt: row.created_at,
        });
        expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
        expect(requests).toEqual([
          {
            method: 'GET',
            url: `/api/invoices/${ref.invoiceId}`,
            auth: 'Bearer LOCAL_FAKE_KEY',
          },
        ]);
      },
    );
  });

  it.each(['headers', 'body'] as const)(
    'aborts stalled %s in ten seconds without retry',
    async (part) => {
      let closed!: Promise<unknown>;
      await withServer(
        (response) => {
          closed = once(response, 'close');
          if (part === 'body') response.write('{"success":true,"invoice":');
        },
        async (client, requests) => {
          const started = Date.now();
          await expect(
            client.getInvoiceStatus(ref, 'acme/widgets'),
          ).rejects.toThrow('Invoice status unavailable');
          expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
          await expectClosed(closed);
          expect(requests).toHaveLength(1);
        },
      );
    },
    15000,
  );

  it.each(['chunked', 'gzip'] as const)(
    'rejects oversized decoded %s data',
    async (encoding) => {
      let closed!: Promise<unknown>;
      await withServer(
        (response) => {
          closed = once(response, 'close');
          const body = JSON.stringify({
            success: true,
            invoice: { ...row, notes: 'x'.repeat(70000) },
          });
          if (encoding === 'gzip') {
            response.setHeader('content-encoding', 'gzip');
            response.write(gzipSync(body));
          } else {
            for (let offset = 0; offset < body.length; offset += 2048)
              response.write(body.slice(offset, offset + 2048));
            // Leave the response open so the client must cancel the remaining read.
          }
        },
        async (client, requests) => {
          await expect(
            client.getInvoiceStatus(ref, 'acme/widgets'),
          ).rejects.toThrow('Invoice status unavailable');
          await expectClosed(closed);
          expect(requests).toHaveLength(1);
        },
      );
    },
  );

  it.each([401, 404, 429, 500])(
    'does not retry or expose the response body on HTTP %i',
    async (code) => {
      await withServer(
        (response) => {
          response.writeHead(code, { 'retry-after': '0' });
          response.end('PRIVATE_SENTINEL');
        },
        async (client, requests) => {
          await expect(
            client.getInvoiceStatus(ref, 'acme/widgets'),
          ).rejects.toMatchObject({ message: 'Invoice status unavailable' });
          expect(requests).toHaveLength(1);
        },
      );
    },
  );

  it('rejects a truncated body before the deadline without retry', async () => {
    await withServer(
      (response) => {
        response.writeHead(200, { 'content-length': '1000' });
        response.write('{"success":true', () => response.socket?.end());
      },
      async (client, requests) => {
        const started = Date.now();
        await expect(
          client.getInvoiceStatus(ref, 'acme/widgets'),
        ).rejects.toThrow('Invoice status unavailable');
        expect(Date.now() - started).toBeLessThan(3000);
        expect(requests).toHaveLength(1);
      },
    );
  });

  it('cancels an unterminated HTTP error body without exposing it', async () => {
    let closed!: Promise<unknown>;
    await withServer(
      (response) => {
        closed = once(response, 'close');
        response.writeHead(503);
        response.write('PRIVATE_SENTINEL');
      },
      async (client, requests) => {
        await expect(
          client.getInvoiceStatus(ref, 'acme/widgets'),
        ).rejects.toMatchObject({ message: 'Invoice status unavailable' });
        await expectClosed(closed);
        expect(requests).toHaveLength(1);
      },
    );
  });
});
