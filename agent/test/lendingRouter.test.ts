import { describe, expect, test } from 'bun:test';
import { createEmptyAgentState } from '../src/core/agentMemory.js';
import { evaluateActionPolicy, shouldRebalance } from '../src/core/policy.js';
import { createToolRegistry } from '../src/core/toolRegistry.js';
import type { AppConfig, Clients, Logger, NormalizedPositions } from '../src/types.js';
import { baseConfig } from './fixtures/baseConfig.js';

const usdcCoinType = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';

function liveConfig(overrides: Partial<AppConfig['sui']> = {}): AppConfig {
  const base = baseConfig({
    runtime: { dryRun: false, nodeEnv: 'test', autonomyIntervalMs: 1000 }
  });
  base.sui = { ...base.sui, ...overrides };
  return base;
}

describe('evaluateActionPolicy (generic lending)', () => {
  test('denies supply to a protocol whose writes are disabled', () => {
    const config = liveConfig({
      protocols: {
        suilend: { enabled: true, write: true },
        navi: { enabled: true, write: false },
        scallop: { enabled: true, write: false }
      }
    });
    const decision = evaluateActionPolicy(
      { type: 'LENDING_SUPPLY', details: { protocol: 'navi', asset: 'usdc', rawAmount: '500' } },
      config
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('navi');
  });

  test('allows supply to a write-enabled protocol within caps', () => {
    const config = liveConfig({
      protocols: {
        suilend: { enabled: true, write: true },
        navi: { enabled: true, write: true },
        scallop: { enabled: true, write: false }
      }
    });
    const decision = evaluateActionPolicy(
      { type: 'LENDING_SUPPLY', details: { protocol: 'navi', asset: 'usdc', rawAmount: '500' } },
      config
    );
    expect(decision.allowed).toBe(true);
  });

  test('borrow fails closed when projected health factor is missing', () => {
    const config = liveConfig({
      enableBorrow: true,
      protocols: {
        suilend: { enabled: true, write: true },
        navi: { enabled: true, write: true },
        scallop: { enabled: true, write: false }
      }
    });
    const decision = evaluateActionPolicy(
      { type: 'LENDING_BORROW', details: { protocol: 'navi', asset: 'usdc', rawAmount: '500' } },
      config
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('health factor');
  });

  test('SUILEND_ alias still maps to the suilend protocol', () => {
    const config = liveConfig();
    const decision = evaluateActionPolicy(
      { type: 'SUILEND_SUPPLY', details: { asset: 'usdc', rawAmount: '500' } },
      config
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('shouldRebalance hysteresis', () => {
  test('does not rebalance below the bps threshold', () => {
    const config = baseConfig();
    const result = shouldRebalance(5.0, 5.2, config); // 20 bps < 50 bps default
    expect(result.rebalance).toBe(false);
    expect(result.deltaBps).toBe(20);
  });

  test('rebalances when the delta clears the threshold', () => {
    const config = baseConfig();
    const result = shouldRebalance(5.0, 6.0, config); // 100 bps >= 50 bps
    expect(result.rebalance).toBe(true);
    expect(result.deltaBps).toBe(100);
  });
});

describe('lending_supply routing', () => {
  test('routes to the requested protocol client', async () => {
    const supplyCalls: string[] = [];
    const clients = routingClients((protocol) => {
      supplyCalls.push(protocol);
    });
    const config = liveConfig({
      protocols: {
        suilend: { enabled: true, write: true },
        navi: { enabled: true, write: true },
        scallop: { enabled: true, write: true }
      }
    });
    const registry = createToolRegistry({
      config,
      clients,
      logger: quietLogger(),
      memory: {
        state: createEmptyAgentState(config),
        runId: 'run-1',
        statePath: 'data/agent-state.json',
        persist: async () => undefined
      }
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'lending_supply',
      call_id: 'c1',
      arguments: JSON.stringify({ protocol: 'scallop', asset: 'usdc', rawAmount: '500' })
    });

    expect(result.ok).toBe(true);
    expect(supplyCalls).toEqual(['scallop']);
  });
});

function routingClients(onSupply: (protocol: string) => void): Clients {
  const emptyPositions = (protocol: 'suilend' | 'navi' | 'scallop'): NormalizedPositions => ({
    protocol,
    healthFactor: Number.POSITIVE_INFINITY,
    borrowLimitUsd: 0,
    weightedBorrowsUsd: 0,
    depositedAmountUsd: 0,
    borrowedAmountUsd: 0,
    deposits: [],
    borrows: []
  });

  const protocolClient = (protocol: 'suilend' | 'navi' | 'scallop') => ({
    name: protocol,
    enabled: true,
    requiresObligationForWrite: false,
    resolveCoinType: (asset: string) => (asset === 'usdc' ? usdcCoinType : asset),
    isAssetAllowed: () => true,
    getMarkets: async () => ({ markets: [] }),
    getPositions: async () => emptyPositions(protocol),
    executeSupply: async () => {
      onSupply(protocol);
      return { digest: `0x${protocol}`, success: true };
    },
    executeWithdraw: async () => ({ digest: '0x', success: true }),
    executeBorrow: async () => ({ digest: '0x', success: true }),
    executeRepay: async () => ({ digest: '0x', success: true }),
    simulateHealthFactorAfterBorrow: async () => Number.POSITIVE_INFINITY
  });

  return {
    suiExecution: {
      assertWalletMatches: async () => ({ address: '0x1' }),
      getCoinBalances: async () => ({
        wallet: '0x1',
        sui: { symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9, raw: '0', formatted: '0' },
        usdc: { symbol: 'USDC', coinType: usdcCoinType, decimals: 6, raw: '10000000', formatted: '10' }
      })
    },
    suilend: protocolClient('suilend'),
    navi: protocolClient('navi'),
    scallop: protocolClient('scallop'),
    openai: { create: async () => ({ output: [] }) },
    walrusMemory: { enabled: false, recall: async () => [], remember: async () => null }
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
