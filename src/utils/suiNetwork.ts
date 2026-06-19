import type { SuiNetwork } from '../types.js';

const MAINNET_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const TESTNET_USDC = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';

export function defaultRpcUrl(network: SuiNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'https://fullnode.mainnet.sui.io:443';
    case 'testnet':
      return 'https://fullnode.testnet.sui.io:443';
    case 'devnet':
      return 'https://fullnode.devnet.sui.io:443';
  }
}

export function defaultExplorerBaseUrl(network: SuiNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'https://suiscan.xyz/mainnet/tx';
    case 'testnet':
      return 'https://suiscan.xyz/testnet/tx';
    case 'devnet':
      return 'https://suiscan.xyz/devnet/tx';
  }
}

export function defaultUsdcCoinType(network: SuiNetwork): string {
  return network === 'mainnet' ? MAINNET_USDC : TESTNET_USDC;
}

export function explorerTxUrl(baseUrl: string, digest: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${digest}`;
}
