const ASSET_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  SUI: 9
};

const DEFAULT_DECIMALS = 9;

/**
 * Resolve token decimals from an asset that may be a clean symbol ("USDC"),
 * a shorthand ("usdc"), or a full Sui coin type ("0x…::usdc::USDC").
 * Mirrors the agent's inferAssetDecimals so raw amounts scale correctly.
 * 6-decimal stablecoins are matched before SUI.
 */
export function assetDecimals(asset: string | undefined): number {
  if (!asset) return DEFAULT_DECIMALS;
  const direct = ASSET_DECIMALS[asset.toUpperCase()];
  if (direct !== undefined) return direct;
  const lower = asset.toLowerCase();
  if (lower.includes('usdc') || lower.includes('usdt')) return 6;
  if (lower.includes('::sui::sui') || lower === 'sui' || lower.endsWith('::sui')) return 9;
  return DEFAULT_DECIMALS;
}

/**
 * Extract a clean display symbol from a symbol, shorthand, or full coin type.
 */
export function assetSymbol(asset: string | undefined): string {
  if (!asset) return '—';
  if (asset.includes('::')) {
    const parts = asset.split('::');
    return (parts[parts.length - 1] || asset).toUpperCase();
  }
  return asset.toUpperCase();
}

export function shortAddr(addr: string | undefined, lead = 6, tail = 4): string {
  if (!addr) return '—';
  if (addr.length <= lead + tail + 2) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: 2
  });
}

export function formatApr(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(2)}%`;
}

export function formatHealthFactor(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value) || !Number.isFinite(value)) return '∞';
  return value.toFixed(2);
}

export function formatRawAmount(raw: string | undefined, asset: string): string {
  if (!raw) return '—';
  const decimals = assetDecimals(asset);
  try {
    const big = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = big / base;
    const frac = big % base;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  } catch {
    return raw;
  }
}

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then) || then <= 0) return '—';
  const diff = Math.round((now - then) / 1000);
  if (diff < 0) return 'in the future';
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function isStale(iso: string | undefined, staleMs: number, now = Date.now()): boolean {
  if (!iso) return true;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return true;
  return now - then > staleMs;
}

export function bpsToPct(bps: number | undefined): string {
  if (bps === undefined || Number.isNaN(bps)) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

const EXPLORER_BASE =
  process.env.NEXT_PUBLIC_SUI_EXPLORER_BASE ?? 'https://suiscan.xyz/mainnet';

export function txUrl(digest: string): string {
  return `${EXPLORER_BASE}/tx/${digest}`;
}

export function addressUrl(addr: string): string {
  return `${EXPLORER_BASE}/account/${addr}`;
}
