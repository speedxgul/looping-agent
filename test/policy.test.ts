import { describe, expect, test } from 'bun:test';
import { evaluateActionPolicy } from '../src/core/policy.js';
import type { AppConfig } from '../src/types.js';

const baseConfig: AppConfig = {
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
    depositCooldownMs: 86400000
  },
  openai: {
    apiKey: '',
    model: 'gpt-5.1',
    baseUrl: 'https://api.openai.com/v1',
    maxToolRounds: 4
  },
  moltx: {
    apiBase: 'https://moltx.io/v1'
  },
  swap: {
    baseUrl: 'https://swap.moltx.io',
    enableQuotes: true,
    enableAutonomousSwaps: false,
    quoteNetwork: 'base',
    quoteSellToken: '',
    quoteBuyToken: '',
    quoteSellAmount: '0',
    maxSlippagePercent: 0.5,
    maxPriceImpactPercent: 1
  },
  fluid: {
    baseUrl: 'https://defi.moltx.io',
    enabled: true,
    enablePositionCreation: true,
    minIdleUsdcRaw: 0n,
    maxSupplyAmountRaw: 1000n,
    allowedFTokens: ['0x00000000000000000000000000000000000000f1'],
    defaultFTokens: {
      usdc: '',
      weth: ''
    }
  },
  evm: {
    accountMode: 'eoa',
    baseRpcUrl: 'https://base.example',
    privateKey: `0x${'11'.repeat(32)}`,
    smartAccountType: 'coinbase',
    smartAccountBundlerUrl: '',
    smartAccountUsePaymaster: false
  },
};

describe('evaluateActionPolicy', () => {
  test('allows fluid supply for allowlisted markets under cap', () => {
    const result = evaluateActionPolicy(
      {
        type: 'FLUID_SUPPLY',
        details: {
          fTokenAddress: '0x00000000000000000000000000000000000000f1',
          rawAmount: '1000'
        }
      },
      baseConfig
    );

    expect(result).toEqual({ allowed: true, reason: 'allowed' });
  });

  test('blocks fluid supply above the configured cap', () => {
    const result = evaluateActionPolicy(
      {
        type: 'FLUID_SUPPLY',
        details: {
          fTokenAddress: '0x00000000000000000000000000000000000000f1',
          rawAmount: '1001'
        }
      },
      baseConfig
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Requested Fluid supply amount exceeds FLUID_MAX_SUPPLY_AMOUNT_RAW');
  });

  test('blocks smart account fluid supply without a bundler url', () => {
    const result = evaluateActionPolicy(
      {
        type: 'FLUID_SUPPLY',
        details: {
          fTokenAddress: '0x00000000000000000000000000000000000000f1',
          rawAmount: '1000'
        }
      },
      {
        ...baseConfig,
        evm: {
          ...baseConfig.evm,
          accountMode: 'smart',
          smartAccountBundlerUrl: ''
        }
      }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SMART_ACCOUNT_BUNDLER_URL is missing');
  });
});
