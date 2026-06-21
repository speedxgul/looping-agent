// Pyth Hermes client — fetch the latest SIGNED price update for given feeds.
//
// The returned `updateData` (signed Wormhole VAAs) is what the on-chain oracle-refresh
// needs: a PTB calls Pyth's `update_price_feeds(updateData)` (which verifies the Wormhole
// guardian signatures on-chain) before the protocol's value-sensitive op, so it doesn't
// abort on a stale price. The same signed bytes are the input to the (deferred) in-TEE
// price verification. This module is the protocol-agnostic, off-chain half — testable
// without any chain.
//
// Who needs the refresh (confirmed against the protocol clients): Suilend supply + withdraw,
// NAVI withdraw. Scallop needs none.

const HERMES = 'https://hermes.pyth.network';

/** Pyth mainnet price-feed ids (hex). */
export const PYTH_FEED_IDS = {
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  SUI: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744'
} as const;

export interface PythPrice {
  feedId: string;
  /** Human-readable price (raw price × 10^expo). */
  price: number;
  /** Confidence interval, same units as price. */
  conf: number;
  /** Unix seconds the price was published. */
  publishTime: number;
}

export interface PythUpdate {
  /** Base64 signed update blobs → on-chain `pyth::update_price_feeds`. */
  updateData: string[];
  prices: PythPrice[];
}

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

/** Fetch the latest signed price update + parsed prices for `feedIds` from Pyth Hermes. */
export async function fetchPythUpdate(
  feedIds: string[],
  fetchImpl: typeof fetch = fetch
): Promise<PythUpdate> {
  if (feedIds.length === 0) throw new Error('fetchPythUpdate: no feed ids');
  const params = feedIds.map((id) => `ids[]=${id}`).join('&');
  const res = await fetchImpl(`${HERMES}/v2/updates/price/latest?${params}&encoding=base64`);
  if (!res.ok) throw new Error(`Pyth Hermes failed: HTTP ${res.status}`);
  const body = (await res.json()) as { binary: { data: string[] }; parsed: HermesParsed[] };
  return {
    updateData: body.binary.data,
    prices: (body.parsed ?? []).map(toPythPrice)
  };
}

function toPythPrice(p: HermesParsed): PythPrice {
  const scale = 10 ** p.price.expo;
  return {
    feedId: p.id.startsWith('0x') ? p.id : `0x${p.id}`,
    price: Number(p.price.price) * scale,
    conf: Number(p.price.conf) * scale,
    publishTime: p.price.publish_time
  };
}

/** How stale a Pyth price is, in seconds, relative to `nowMs`. */
export function priceAgeSeconds(price: PythPrice, nowMs: number): number {
  return Math.floor(nowMs / 1000) - price.publishTime;
}
