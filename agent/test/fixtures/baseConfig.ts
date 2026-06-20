import type { AppConfig } from '../../src/types.js';

export function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    runtime: {
      dryRun: true,
      nodeEnv: 'test',
      autonomyIntervalMs: 1000
    },
    logLevel: 'info',
    agent: {
      name: 'TestAgent',
      walletAddress: '0x0000000000000000000000000000000000000001',
      mission: 'test',
      statePath: 'data/agent-state.json',
      actionCooldownMs: 86400000
    },
    openai: {
      apiKey: '',
      model: 'gpt-5.1',
      baseUrl: 'https://api.openai.com/v1',
      maxToolRounds: 4
    },
    x: {
      enablePosting: false,
      userAccessToken: '',
      apiBase: 'https://api.x.com'
    },
    sui: {
      enabled: true,
      enablePositionCreation: true,
      enableBorrow: false,
      rpcUrl: 'https://fullnode.testnet.sui.io:443',
      network: 'testnet',
      privateKey: `0x${'11'.repeat(32)}`,
      walletAddress: '0x0000000000000000000000000000000000000001',
      usdcCoinType: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
      suiCoinType: '0x2::sui::SUI',
      allowedAssets: ['usdc'],
      allowedPools: [],
      minIdleRaw: 0n,
      maxSupplyRaw: 1000n,
      maxBorrowRaw: 1000n,
      minHealthFactor: 1.25,
      explorerBaseUrl: 'https://suiscan.xyz/testnet/tx',
      allowedProtocols: ['suilend', 'navi', 'scallop'],
      rebalanceMinAprDeltaBps: 50,
      defaultAssets: { usdc: 'usdc', sui: 'sui' },
      protocols: {
        suilend: { enabled: true, write: true },
        navi: { enabled: false, write: false },
        scallop: { enabled: false, write: false }
      }
    },
    treasury: {
      enabled: false,
      packageId: '',
      treasuryId: '',
      agentCapId: '',
      registryId: '',
      enclaveId: '',
      enclaveUrl: ''
    },
    walrus: {
      memoryBackend: 'file',
      publisherUrl: 'https://publisher.walrus-testnet.walrus.space',
      aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
      epochs: 5,
      stateBlobId: '',
      memwal: {
        enabled: false,
        accountId: '',
        delegateKey: '',
        relayerUrl: 'https://relayer-staging.memory.walrus.xyz',
        namespace: 'defi-agent'
      }
    },
    ...overrides
  };
}
