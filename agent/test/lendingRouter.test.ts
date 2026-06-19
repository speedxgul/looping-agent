import { describe, expect, test } from 'bun:test';
import { createEmptyAgentState } from '../src/core/agentMemory.js';
import type { ReserveCurve } from '../src/core/allocation.js';
import { evaluateActionPolicy, evaluateRebalanceBreakeven, shouldRebalance } from '../src/core/policy.js';
import { createToolRegistry } from '../src/core/toolRegistry.js';
import type { AppConfig, Clients, LendingProtocol, Logger, NormalizedPositions } from '../src/types.js';
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

describe('evaluateRebalanceBreakeven', () => {
  test('blocks moves whose expected gain does not clear cost', () => {
    const config = baseConfig();
    const result = evaluateRebalanceBreakeven(
      { currentNetApr: 5, targetNetApr: 6, amountUsd: 10, horizonDays: 7, costUsd: 0.02 },
      config
    );
    expect(result.act).toBe(false);
    expect(result.reason).toContain('does not exceed cost');
  });

  test('allows moves that clear bps threshold and cost', () => {
    const config = baseConfig();
    const result = evaluateRebalanceBreakeven(
      { currentNetApr: 5, targetNetApr: 8, amountUsd: 1000, horizonDays: 30, costUsd: 0.02 },
      config
    );
    expect(result.act).toBe(true);
    expect(result.deltaBps).toBe(300);
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

describe('get_rebalance_plan', () => {
  test('returns disabled when rebalancing is not enabled', async () => {
    const config = liveConfig({
      rebalancing: { enabled: false, planOnly: true, horizonDays: 7, estimatedCostUsd: 0.02 }
    });
    const registry = createToolRegistry({
      config,
      clients: rebalanceClients({}),
      logger: quietLogger(),
      memory: testMemory(config)
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'get_rebalance_plan',
      call_id: 'c1',
      arguments: '{}'
    });

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.moves).toEqual([]);
  });

  test('rejects a move when the APR delta is below the threshold', async () => {
    const config = rebalanceConfig({ rebalanceMinAprDeltaBps: 200 });
    const registry = createToolRegistry({
      config,
      clients: rebalanceClients({
        suilendDepositRaw: usdc(1000),
        naviRewardApr: 1
      }),
      logger: quietLogger(),
      memory: testMemory(config)
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'get_rebalance_plan',
      call_id: 'c1',
      arguments: '{}'
    });

    expect(result.ok).toBe(true);
    expect(result.moves).toEqual([]);
    expect(Array.isArray(result.rejected)).toBe(true);
  });

  test('rejects a move when expected gain does not clear cost', async () => {
    const config = rebalanceConfig({
      rebalancing: { enabled: true, planOnly: true, horizonDays: 7, estimatedCostUsd: 10 }
    });
    const registry = createToolRegistry({
      config,
      clients: rebalanceClients({
        suilendDepositRaw: usdc(1000),
        naviRewardApr: 3
      }),
      logger: quietLogger(),
      memory: testMemory(config)
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'get_rebalance_plan',
      call_id: 'c1',
      arguments: '{}'
    });

    expect(result.ok).toBe(true);
    expect(result.moves).toEqual([]);
    expect(JSON.stringify(result.rejected)).toContain('does not exceed cost');
  });

  test('proposes a plan-only withdraw and supply when gates clear', async () => {
    const config = rebalanceConfig({
      maxSupplyRaw: BigInt(usdc(1000)),
      rebalancing: { enabled: true, planOnly: true, horizonDays: 30, estimatedCostUsd: 0.01 }
    });
    const registry = createToolRegistry({
      config,
      clients: rebalanceClients({
        suilendDepositRaw: usdc(1000),
        naviRewardApr: 5
      }),
      logger: quietLogger(),
      memory: testMemory(config)
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'get_rebalance_plan',
      call_id: 'c1',
      arguments: '{}'
    });

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.executionAllowed).toBe(false);
    const moves = result.moves as Array<Record<string, unknown>>;
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0]?.fromProtocol).toBe('suilend');
    expect(moves[0]?.toProtocol).toBe('navi');
    expect(moves[0]?.planOnly).toBe(true);
  });

  test('rejects dust moves below the configured minimum', async () => {
    const config = rebalanceConfig({
      minIdleRaw: BigInt(usdc(2000)),
      maxSupplyRaw: BigInt(usdc(1000)),
      rebalancing: { enabled: true, planOnly: true, horizonDays: 30, estimatedCostUsd: 0.01 }
    });
    const registry = createToolRegistry({
      config,
      clients: rebalanceClients({
        suilendDepositRaw: usdc(1000),
        naviRewardApr: 5
      }),
      logger: quietLogger(),
      memory: testMemory(config)
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'get_rebalance_plan',
      call_id: 'c1',
      arguments: '{}'
    });

    expect(result.ok).toBe(true);
    expect(result.moves).toEqual([]);
    expect(JSON.stringify(result.rejected)).toContain('dust threshold');
  });

  test('does not propose moves into disabled or non-allowlisted protocols', async () => {
    const config = rebalanceConfig({
      allowedProtocols: ['suilend'],
      protocols: {
        suilend: { enabled: true, write: true },
        navi: { enabled: true, write: true },
        scallop: { enabled: true, write: true }
      },
      rebalancing: { enabled: true, planOnly: true, horizonDays: 30, estimatedCostUsd: 0.01 }
    });
    const registry = createToolRegistry({
      config,
      clients: rebalanceClients({
        suilendDepositRaw: usdc(1000),
        naviRewardApr: 5
      }),
      logger: quietLogger(),
      memory: testMemory(config)
    });

    const result = await registry.execute({
      type: 'function_call',
      name: 'get_rebalance_plan',
      call_id: 'c1',
      arguments: '{}'
    });

    expect(result.ok).toBe(true);
    expect(result.moves).toEqual([]);
    expect(JSON.stringify(result.skipped)).toContain('navi');
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

function rebalanceConfig(overrides: Partial<AppConfig['sui']> = {}): AppConfig {
  return liveConfig({
    protocols: {
      suilend: { enabled: true, write: true },
      navi: { enabled: true, write: true },
      scallop: { enabled: true, write: false }
    },
    minIdleRaw: 0n,
    maxSupplyRaw: BigInt(usdc(10_000)),
    rebalancing: { enabled: true, planOnly: true, horizonDays: 7, estimatedCostUsd: 0.02 },
    ...overrides
  });
}

function rebalanceClients({
  suilendDepositRaw = '0',
  naviDepositRaw = '0',
  naviRewardApr = 0
}: {
  suilendDepositRaw?: string;
  naviDepositRaw?: string;
  naviRewardApr?: number;
}): Clients {
  const deposits: Record<LendingProtocol, string> = {
    suilend: suilendDepositRaw,
    navi: naviDepositRaw,
    scallop: '0'
  };

  const protocolClient = (protocol: LendingProtocol, rewardSupplyApr = 0) => ({
    name: protocol,
    enabled: true,
    requiresObligationForWrite: false,
    resolveCoinType: (asset: string) => (asset === 'usdc' ? usdcCoinType : asset),
    isAssetAllowed: () => true,
    getMarkets: async () => ({ markets: [market(protocol, rewardSupplyApr)] }),
    getPositions: async () => positions(protocol, deposits[protocol]),
    executeSupply: async () => ({ digest: '0x', success: true }),
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
        usdc: { symbol: 'USDC', coinType: usdcCoinType, decimals: 6, raw: '0', formatted: '0' }
      })
    },
    suilend: protocolClient('suilend'),
    navi: protocolClient('navi', naviRewardApr),
    scallop: protocolClient('scallop'),
    openai: { create: async () => ({ output: [] }) },
    walrusMemory: { enabled: false, recall: async () => [], remember: async () => null }
  } as unknown as Clients;
}

function market(protocol: LendingProtocol, rewardSupplyApr: number) {
  const curve = reserveCurve(protocol, rewardSupplyApr);
  return {
    coinType: usdcCoinType,
    symbol: 'USDC',
    decimals: 6,
    supplyApr: 5,
    borrowApr: 8,
    totalApr: 5 + rewardSupplyApr,
    price: 1,
    allowed: true,
    curve
  };
}

function reserveCurve(protocol: LendingProtocol, rewardSupplyApr: number): ReserveCurve {
  return {
    protocol,
    asset: 'usdc',
    coinType: usdcCoinType,
    borrowAprPoints: [
      { util: 0, apr: 0 },
      { util: 0.8, apr: 8 },
      { util: 1, apr: 60 }
    ],
    reserveFactorPct: 20,
    borrowedRaw: usdc(800_000),
    availableLiquidityRaw: usdc(200_000),
    decimals: 6,
    price: 1,
    rewardSupplyApr
  };
}

function positions(protocol: LendingProtocol, depositRaw: string): NormalizedPositions {
  return {
    protocol,
    healthFactor: Number.POSITIVE_INFINITY,
    borrowLimitUsd: 0,
    weightedBorrowsUsd: 0,
    depositedAmountUsd: Number(BigInt(depositRaw)) / 1e6,
    borrowedAmountUsd: 0,
    deposits:
      BigInt(depositRaw) > 0n
        ? [
            {
              coinType: usdcCoinType,
              symbol: 'USDC',
              amount: depositRaw,
              amountUsd: Number(BigInt(depositRaw)) / 1e6,
              side: 'deposit'
            }
          ]
        : [],
    borrows: []
  };
}

function testMemory(config: AppConfig) {
  return {
    state: createEmptyAgentState(config),
    runId: 'run-1',
    statePath: 'data/agent-state.json',
    persist: async () => undefined
  };
}

function usdc(amount: number): string {
  return BigInt(Math.round(amount * 1_000_000)).toString();
}

function quietLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
