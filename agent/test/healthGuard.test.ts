import { describe, expect, test } from 'bun:test';
import { createEmptyAgentState } from '../src/core/agentMemory.js';
import { runHealthGuard } from '../src/core/healthGuard.js';
import type { AppConfig, Clients, Logger } from '../src/types.js';
import { baseConfig } from './fixtures/baseConfig.js';

const usdcCoinType = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';

describe('runHealthGuard', () => {
  test('dry-run records planned repay when health factor is critical', async () => {
    const state = createEmptyAgentState(baseConfig());
    const clients = createClients({
      healthFactor: 1.1,
      borrows: [
        {
          coinType: usdcCoinType,
          symbol: 'USDC',
          amount: '1000000',
          amountUsd: 1
        }
      ]
    });

    const result = await runHealthGuard({
      state,
      runId: 'run-1',
      clients,
      config: baseConfig(),
      logger: quietLogger(),
      persist: async () => undefined
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe('Dry run: planned auto-repay');
    expect(state.actions.positionActions[0]).toMatchObject({
      action: 'repay',
      status: 'planned',
      dryRun: true
    });
    expect(state.pending.some((task) => task.type === 'health_alert')).toBe(true);
  });

  test('skips when health factor is ok', async () => {
    const state = createEmptyAgentState(baseConfig());
    const clients = createClients({
      healthFactor: 1.5,
      borrows: [
        {
          coinType: usdcCoinType,
          symbol: 'USDC',
          amount: '1000000',
          amountUsd: 1
        }
      ]
    });

    const result = await runHealthGuard({
      state,
      runId: 'run-1',
      clients,
      config: baseConfig(),
      logger: quietLogger(),
      persist: async () => undefined
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe('Health factor ok');
    expect(state.actions.positionActions).toHaveLength(0);
  });

  test('executes repay in live mode when health factor is critical', async () => {
    const state = createEmptyAgentState(
      baseConfig({ runtime: { dryRun: false, nodeEnv: 'test', autonomyIntervalMs: 1000 } })
    );
    let repayCalled = false;
    const clients = createClients({
      healthFactor: 1.1,
      borrows: [
        {
          coinType: usdcCoinType,
          symbol: 'USDC',
          amount: '500',
          amountUsd: 1
        }
      ],
      executeRepay: async () => {
        repayCalled = true;
        return { digest: '0xrepay', success: true };
      }
    });

    const result = await runHealthGuard({
      state,
      runId: 'run-1',
      clients,
      config: baseConfig({ runtime: { dryRun: false, nodeEnv: 'test', autonomyIntervalMs: 1000 } }),
      logger: quietLogger(),
      persist: async () => undefined
    });

    expect(repayCalled).toBe(true);
    expect(result.executed).toBe(true);
    expect(state.actions.positionActions[0]).toMatchObject({
      action: 'repay',
      status: 'confirmed',
      digest: '0xrepay',
      dryRun: false
    });
    expect(state.pending.some((task) => task.type === 'health_alert')).toBe(false);
  });
});

function createClients(
  options: {
    healthFactor?: number;
    borrows?: Array<{ coinType: string; symbol: string; amount: string; amountUsd: number }>;
    executeRepay?: Clients['suilend']['executeRepay'];
  } = {}
): Clients {
  return {
    suiExecution: {
      isConfigured: () => true,
      getAddress: () => '0x1',
      assertWalletMatches: async () => ({ address: '0x1' }),
      getCoinBalances: async () => ({
        wallet: '0x1',
        sui: { symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9, raw: '0', formatted: '0' },
        usdc: { symbol: 'USDC', coinType: usdcCoinType, decimals: 6, raw: '10000000', formatted: '10' }
      }),
      signAndExecute: async () => ({ digest: '0xabc', effects: {} })
    },
    suilend: {
      resolveCoinType: (asset: string) => asset,
      getMarkets: async () => ({ markets: [] }),
      getObligation: async () => ({
        obligationId: '0xobligation',
        deposits: [],
        borrows: options.borrows ?? [],
        healthFactor: options.healthFactor ?? null,
        borrowLimitUsd: 0,
        liquidationThresholdUsd: 0
      }),
      executeSupply: async () => ({ digest: '0xabc' }),
      executeWithdraw: async () => ({ digest: '0xabc' }),
      executeBorrow: async () => ({ digest: '0xabc' }),
      executeRepay:
        options.executeRepay ??
        (async () => {
          return { digest: '0xabc' };
        })
    },
    navi: { isEnabled: () => false, getRates: async () => ({ rates: [] }) },
    scallop: { isEnabled: () => false, getRates: async () => ({ rates: [] }) },
    openai: { create: async () => ({ output: [] }) },
    walrusBlob: {
      upload: async () => ({ blobId: 'blob-1', url: 'https://example.com/blob-1' }),
      download: async () => null
    },
    walrusMemory: { recall: async () => [], remember: async () => undefined }
  } as unknown as Clients;
}

function quietLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
