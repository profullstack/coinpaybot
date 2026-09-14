import { describe, expect, it } from 'vitest';
import { CoinPayClient } from '../src/coinpay.js';

const id = '11111111-2222-4333-8444-555555555555';
const client = (baseUrl = 'https://coinpayportal.com') => new CoinPayClient({ baseUrl, apiKey: 'unused', businessId: 'unused' });

describe('invoice PDF URL', () => {
  it('uses the configured origin and validated ID, not an API-provided link', () => {
    expect(client('https://portal.example/').invoicePdfLink(id)).toBe(`https://portal.example/api/invoices/${id}/pdf`);
  });
  it.each(['../mark-paid', 'https://evil.example', `${id}?secret=yes`, `${id}\nextra`])('rejects ID %j', invalid => {
    expect(client().invoicePdfLink(invalid)).toBeNull();
  });
  it.each(['javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/?secret=yes', 'https://example.com/path', 'http://remote.example', 'not-url'])('omits optional link for invalid origin %j', base => {
    expect(client(base).invoicePdfLink(id)).toBeNull();
  });
  it('allows explicit loopback development origins', () => {
    expect(client('http://127.0.0.1:8080').invoicePdfLink(id)).toBe(`http://127.0.0.1:8080/api/invoices/${id}/pdf`);
  });
});
