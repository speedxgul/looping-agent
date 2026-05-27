import type { NetworkName } from '../types.js';

interface RegisteredToken {
  chain: NetworkName;
  chainId: number;
  symbol: string;
  decimals: number;
  address: string;
}

export const TOKENS: Record<'base', Record<'USDC' | 'WETH', RegisteredToken>> = {
  base: {
    USDC: {
      chain: 'base',
      chainId: 8453,
      symbol: 'USDC',
      decimals: 6,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    },
    WETH: {
      chain: 'base',
      chainId: 8453,
      symbol: 'WETH',
      decimals: 18,
      address: '0x4200000000000000000000000000000000000006'
    }
  }
} as const;

export function findTokenByAddress(network: NetworkName, address: string): RegisteredToken | undefined {
  if (network !== 'base') {
    return undefined;
  }

  const tokens = TOKENS[network] ?? {};
  return Object.values(tokens).find(
    (token) => token.address.toLowerCase() === String(address).toLowerCase()
  );
}
