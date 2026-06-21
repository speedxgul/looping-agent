import { describe, expect, it } from 'bun:test';
import { fetchPythUpdate, PYTH_FEED_IDS, priceAgeSeconds } from '../src/clients/http/pythClient.js';

const mockFetch = (body: unknown, ok = true, status = 200) =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

describe('fetchPythUpdate', () => {
  it('returns the signed update blobs and applies the price exponent', async () => {
    const body = {
      binary: { data: ['c2lnbmVkLXZhYQ=='] },
      parsed: [
        {
          id: PYTH_FEED_IDS.USDC.slice(2), // Hermes returns ids without 0x
          price: { price: '99980000', conf: '60000', expo: -8, publish_time: 1_700_000_000 }
        }
      ]
    };
    const u = await fetchPythUpdate([PYTH_FEED_IDS.USDC], mockFetch(body));
    expect(u.updateData).toEqual(['c2lnbmVkLXZhYQ==']);
    const p = u.prices[0];
    if (!p) throw new Error('expected a parsed price');
    expect(p.price).toBeCloseTo(0.9998, 4); // 99980000 × 10^-8
    expect(p.conf).toBeCloseTo(0.0006, 4);
    expect(p.feedId).toBe(PYTH_FEED_IDS.USDC); // 0x re-prefixed
    expect(p.publishTime).toBe(1_700_000_000);
  });

  it('throws (fail-closed) on a Hermes HTTP error', async () => {
    await expect(fetchPythUpdate([PYTH_FEED_IDS.USDC], mockFetch({}, false, 503))).rejects.toThrow();
  });

  it('throws when given no feed ids', async () => {
    await expect(fetchPythUpdate([], mockFetch({}))).rejects.toThrow();
  });
});

describe('priceAgeSeconds', () => {
  it('computes staleness in seconds vs now', () => {
    const price = { feedId: '0x', price: 1, conf: 0, publishTime: 1_700_000_000 };
    expect(priceAgeSeconds(price, 1_700_000_010_000)).toBe(10);
  });
});
