import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHmacSha256, hmacSha256, timingSafeEqual } from '../../src/htmx/crypto.js';
import { signActionUrl } from '../../src/htmx/testing.js';

// 11 key lengths × 8 message lengths = the 88 D10 vectors, including block/padding boundaries.
describe.each([0, 1, 16, 32, 63, 64, 65, 100, 127, 128, 200])('HMAC-SHA256 key length %i', keyLength => {
  it.each([0, 1, 55, 56, 63, 64, 65, 1000])('matches node:crypto for message length %i', length => {
    const key = Uint8Array.from({ length: keyLength }, (_, i) => (i * 17 + 131) % 256);
    const message = Uint8Array.from({ length }, (_, i) => (i * 31 + 129) % 256);
    const expected = createHmac('sha256', key).update(message).digest('hex');
    expect(Buffer.from(hmacSha256(key, message)).toString('hex')).toBe(expected);
    const cached = createHmacSha256(key);
    expect(Buffer.from(cached(message)).toString('hex')).toBe(expected);
    // Signing different messages between uses must not mutate the cached states.
    cached(new Uint8Array([1, 2, 3]));
    expect(Buffer.from(cached(message)).toString('hex')).toBe(expected);
  });
});
it('compares equal, unequal and differently sized signatures', () => {
  expect(timingSafeEqual('abc', 'abc')).toBe(true);
  expect(timingSafeEqual('abc', 'abd')).toBe(false);
  expect(timingSafeEqual('abc', 'ab')).toBe(false);
});
it('signs a versioned unambiguous tuple with UTF-8 and exact pathname identity', () => {
  const address = { routeId: 'routes/口.tsx', pathname: '/a%2Fb', method: 'post', actionId: '口@0', scope: { a: 'é' } };
  const url = new URL(signActionUrl(address, '秘密'), 'http://localhost');
  const message = JSON.stringify(['recooler.action.v1', address.routeId, address.pathname, 'POST', address.actionId, JSON.stringify(address.scope)]);
  expect(url.searchParams.get('sig')).toBe(createHmac('sha256', '秘密').update(message).digest('base64url'));
  expect(() => signActionUrl(address, '')).toThrow('nonempty');
});

it('snapshots key pads when creating a signer', () => {
  const key = new TextEncoder().encode('original secret');
  const message = new TextEncoder().encode('message');
  const expected = createHmac('sha256', key).update(message).digest('hex');
  const sign = createHmacSha256(key);
  key.fill(0);
  expect(Buffer.from(sign(message)).toString('hex')).toBe(expected);
});
