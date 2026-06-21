import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmptyStrategyLedger,
  type LoopStrategyProposal,
  type MarketSnapshot,
  type PositionSnapshot,
  recordHeartbeat,
  StrategyLedgerStore,
  type StrategyLedgerV1,
  staleSubagents
} from '../src/core/strategyLedger.js';
import {
  buildLoopProposal,
  claimAndExecuteAcceptedPlan,
  runCoordinator,
  runExecutor,
  runLoopStrategist,
  runPositionRisk,
  runRateScout,
  runUnwindGuard,
  validateExecutorGate,
  validateLoopProposal
} from '../src/core/subagents.js';
import type { AppConfig, Clients, LendingProtocol, Logger, NormalizedPositions } from '../src/types.js';
import { baseConfig } from './fixtures/baseConfig.js';

describe('StrategyLedgerStore', () => {
  test('loads an empty v1 ledger when no file exists', () => {
    const config = loopConfig(tempLedgerPath());
    const store = new StrategyLedgerStore({ config, logger: quietLogger() });

    const ledger = store.load();

    expect(ledger.version).toBe(1);
    expect(ledger.strategyProposals).toEqual([]);
    expect(ledger.subagents.coordinator.role).toBe('coordinator');
  });

  test('lock-protected updates do not lose concurrent writes', async () => {
    const config = loopConfig(tempLedgerPath());
    const store = new StrategyLedgerStore({ config, logger: quietLogger(), lockTimeoutMs: 3000 });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((ledger) => {
          ledger.marketSnapshots.unshift({
            id: `snapshot-${index}`,
            runId: `run-${index}`,
            capturedAt: new Date().toISOString(),
            rates: []
          });
        })
      )
    );

    expect(store.load().marketSnapshots).toHaveLength(20);
  });

  test('detects stale subagent heartbeats', () => {
    const config = loopConfig(tempLedgerPath());
    const ledger = createEmptyStrategyLedger(config);
    recordHeartbeat(ledger, 'rate-scout', { status: 'ok' });
    ledger.subagents['rate-scout'].heartbeatAt = new Date(Date.now() - 10_000).toISOString();

    expect(staleSubagents(ledger, 1000).map((heartbeat) => heartbeat.role)).toContain('rate-scout');
  });
});

describe('loop proposal policy', () => {
  test('builds borrow-against-existing-collateral proposal from NAVI USDC deposit', () => {
    const config = loopConfig(tempLedgerPath());
    config.loopStrategy.borrowCapacityFraction = 0.25;
    const ledger = createEmptyStrategyLedger(config);
    ledger.marketSnapshots.unshift(existingCollateralMarketSnapshot());
    ledger.positionSnapshots.unshift(existingCollateralPositionSnapshot(config));

    const proposal = buildLoopProposal({
      config,
      runId: 'strategy-existing',
      market: first(ledger.marketSnapshots),
      positions: first(ledger.positionSnapshots)
    });

    expect(proposal?.proposalType).toBe('borrow_against_existing_collateral');
    expect(proposal?.collateralProtocol).toBe('navi');
    expect(proposal?.supplyTargetProtocol).toBe('scallop');
    expect(proposal?.sourcePositionId).toContain('navi');
    expect(proposal?.borrowUsd).toBe(5);
    expect(proposal?.rawBorrowAmount).toBe('5000000000');
  });

  test('sizes existing-collateral proposal even when first-borrow limit is not exposed', () => {
    const config = loopConfig(tempLedgerPath());
    config.loopStrategy.maxBorrowUsd = 25;
    config.loopStrategy.borrowCapacityFraction = 0.25;
    const ledger = createEmptyStrategyLedger(config);
    ledger.marketSnapshots.unshift(existingCollateralMarketSnapshot());
    const positions = existingCollateralPositionSnapshot(config);
    first(positions.protocols).borrowLimitUsd = 0;
    ledger.positionSnapshots.unshift(positions);

    const proposal = buildLoopProposal({
      config,
      runId: 'strategy-fallback-capacity',
      market: first(ledger.marketSnapshots),
      positions: first(ledger.positionSnapshots)
    });

    expect(proposal?.proposalType).toBe('borrow_against_existing_collateral');
    expect(proposal?.borrowUsd).toBe(2.5);
    expect(proposal?.projectedHealthFactor).toBe(4);
  });

  test('rejects expired, low-HF, low-APR, oversized, same-protocol, and stale-snapshot plans', () => {
    const config = loopConfig(tempLedgerPath());
    const ledger = seededLedger(config);
    const valid = validProposal(ledger);

    expect(validateLoopProposal({ ...valid, expiresAt: oldIso() }, ledger, config).reason).toContain(
      'expired'
    );
    expect(validateLoopProposal({ ...valid, projectedHealthFactor: 1.1 }, ledger, config).reason).toContain(
      'health factor'
    );
    expect(validateLoopProposal({ ...valid, projectedNetAprBps: 50 }, ledger, config).reason).toContain(
      'net APR'
    );
    expect(validateLoopProposal({ ...valid, borrowUsd: 26 }, ledger, config).reason).toContain(
      'LOOP_MAX_BORROW_USD'
    );
    expect(
      validateLoopProposal({ ...valid, supplyTargetProtocol: valid.collateralProtocol }, ledger, config)
        .reason
    ).toContain('different protocol');

    const staleLedger = seededLedger(config);
    first(staleLedger.marketSnapshots).capturedAt = oldIso();
    expect(validateLoopProposal(validProposal(staleLedger), staleLedger, config).reason).toContain(
      'Market snapshot'
    );
  });

  test('coordinator accepts only one active execution plan', async () => {
    const config = loopConfig(tempLedgerPath());
    const store = new StrategyLedgerStore({ config, logger: quietLogger() });
    const ledger = seededLedger(config);
    ledger.strategyProposals.unshift(validProposal(ledger, 'a'), validProposal(ledger, 'b'));
    store.save(ledger);

    const options = tickOptions(config, store, mockClients());
    await runCoordinator(options, 'coordinator-run');
    await runCoordinator(options, 'coordinator-run-2');

    const saved = store.load();
    expect(saved.acceptedPlans).toHaveLength(1);
    expect(saved.strategyProposals.filter((proposal) => proposal.status === 'accepted')).toHaveLength(1);
  });

  test('executor gate refuses live execution unless live flags are enabled', () => {
    const config = loopConfig(tempLedgerPath());
    config.runtime.dryRun = false;
    config.sui.enableBorrow = false;
    config.loopStrategy.executionEnabled = true;
    const ledger = seededLedger(config);

    const decision = validateExecutorGate(validProposal(ledger), ledger, config);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('ENABLE_SUI_BORROW');
  });

  test('execution claim prevents duplicate submission when main agent and executor race', async () => {
    const config = loopConfig(tempLedgerPath());
    const clients = mockClients({ naviDepositUsd: 20, naviBorrowLimitUsd: 20 });
    const store = new StrategyLedgerStore({ config, logger: quietLogger() });
    const ledger = createEmptyStrategyLedger(config);
    ledger.marketSnapshots.unshift(existingCollateralMarketSnapshot());
    ledger.positionSnapshots.unshift(existingCollateralPositionSnapshot(config));
    const proposal = buildLoopProposal({
      config,
      runId: 'race-proposal',
      market: first(ledger.marketSnapshots),
      positions: first(ledger.positionSnapshots)
    });
    if (!proposal) {
      throw new Error('Expected existing collateral proposal');
    }
    ledger.strategyProposals.unshift({ ...proposal, status: 'accepted' });
    ledger.acceptedPlans.unshift({
      id: `plan-${proposal.id}`,
      proposalId: proposal.id,
      acceptedAt: new Date().toISOString(),
      status: 'accepted',
      policy: { allowed: true, reason: 'test', checkedAt: new Date().toISOString() }
    });
    store.save(ledger);

    const [main, executor] = await Promise.all([
      claimAndExecuteAcceptedPlan({
        ...tickOptions(config, store, clients),
        actor: 'main-agent',
        runId: 'main-race'
      }),
      claimAndExecuteAcceptedPlan({
        ...tickOptions(config, store, clients),
        actor: 'executor',
        runId: 'executor-race'
      })
    ]);

    const saved = store.load();
    expect(saved.executionReceipts).toHaveLength(1);
    expect(saved.acceptedPlans[0]?.status).toBe('executed');
    expect([main.claimed, executor.claimed].filter(Boolean)).toHaveLength(1);
  });
});

describe('subagent integration flow', () => {
  test('scout, risk, strategist, coordinator, executor, and unwind guard update the shared ledger', async () => {
    const config = loopConfig(tempLedgerPath());
    const clients = mockClients({ suilendHealthFactor: 2.5 });
    const store = new StrategyLedgerStore({ config, logger: quietLogger() });
    const options = tickOptions(config, store, clients);

    await runRateScout(options, 'rates-1');
    await runPositionRisk(options, 'positions-1');
    await runLoopStrategist(options, 'strategy-1');
    await runCoordinator(options, 'coordinator-1');
    await runExecutor(options, 'executor-1');

    let ledger = store.load();
    expect(first(ledger.marketSnapshots).rates.some((rate) => rate.asset === 'SUI')).toBe(true);
    expect(
      first(ledger.positionSnapshots).protocols.some((protocol) => protocol.protocol === 'suilend')
    ).toBe(true);
    expect(first(ledger.strategyProposals).collateralAsset).toBe('USDC');
    expect(first(ledger.acceptedPlans).status).toBe('executed');
    expect(first(ledger.executionReceipts).dryRun).toBe(true);
    expect(first(ledger.executionReceipts).legs.map((leg) => leg.status)).toEqual([
      'planned',
      'planned',
      'planned'
    ]);

    const critical = mockClients({ suilendHealthFactor: 1.2, suilendBorrowUsd: 10 });
    await runPositionRisk(tickOptions(config, store, critical), 'positions-critical');
    await runUnwindGuard(tickOptions(config, store, critical), 'unwind-1');

    ledger = store.load();
    expect(first(ledger.riskLocks).active).toBe(true);
    expect(first(ledger.riskLocks).severity).toBe('critical');
  });
});

function loopConfig(ledgerPath: string): AppConfig {
  const config = baseConfig();
  config.runtime.dryRun = true;
  config.sui.enableBorrow = true;
  config.sui.protocols = {
    suilend: { enabled: true, write: true },
    navi: { enabled: true, write: true },
    scallop: { enabled: true, write: true }
  };
  config.loopStrategy = {
    ...config.loopStrategy,
    ledgerPath,
    enabled: true,
    executionEnabled: false,
    minNetAprBps: 100,
    minHealthFactor: 1.75,
    criticalHealthFactor: 1.45,
    maxBorrowUsd: 25,
    maxCollateralUsd: 100,
    staleSnapshotMs: 600000
  };
  return config;
}

function seededLedger(config: AppConfig): StrategyLedgerV1 {
  const ledger = createEmptyStrategyLedger(config);
  ledger.marketSnapshots.unshift(marketSnapshot());
  ledger.positionSnapshots.unshift(positionSnapshot(config));
  return ledger;
}

function validProposal(ledger: StrategyLedgerV1, suffix = 'valid'): LoopStrategyProposal {
  const proposal = buildLoopProposal({
    config: loopConfig(tempLedgerPath()),
    runId: `proposal-run-${suffix}`,
    market: first(ledger.marketSnapshots),
    positions: first(ledger.positionSnapshots)
  });
  if (!proposal) {
    throw new Error('Expected valid proposal fixture');
  }
  proposal.id = `proposal-${suffix}`;
  return proposal;
}

function marketSnapshot(): MarketSnapshot {
  return {
    id: 'market-1',
    runId: 'rates-1',
    capturedAt: new Date().toISOString(),
    rates: [
      {
        protocol: 'suilend',
        asset: 'USDC',
        coinType: 'usdc-coin',
        supplyApr: 2,
        borrowApr: 0,
        priceUsd: 1
      },
      {
        protocol: 'suilend',
        asset: 'SUI',
        coinType: 'sui-coin',
        supplyApr: 1,
        borrowApr: 4,
        priceUsd: 1
      },
      {
        protocol: 'navi',
        asset: 'SUI',
        coinType: 'sui-coin',
        supplyApr: 7,
        borrowApr: 5,
        priceUsd: 1
      }
    ]
  };
}

function existingCollateralMarketSnapshot(): MarketSnapshot {
  return {
    id: 'market-existing',
    runId: 'rates-existing',
    capturedAt: new Date().toISOString(),
    rates: [
      {
        protocol: 'navi',
        asset: 'SUI',
        coinType: 'sui-coin',
        supplyApr: 2,
        borrowApr: 4,
        priceUsd: 1
      },
      {
        protocol: 'suilend',
        asset: 'SUI',
        coinType: 'sui-coin',
        supplyApr: 3,
        borrowApr: 5,
        priceUsd: 1
      },
      {
        protocol: 'scallop',
        asset: 'SUI',
        coinType: 'sui-coin',
        supplyApr: 7,
        borrowApr: 6,
        priceUsd: 1
      }
    ]
  };
}

function positionSnapshot(config: AppConfig): PositionSnapshot {
  return {
    id: 'positions-1',
    runId: 'positions-1',
    walletAddress: config.agent.walletAddress,
    capturedAt: new Date().toISOString(),
    protocols: [
      {
        protocol: 'suilend',
        healthFactor: Number.POSITIVE_INFINITY,
        borrowLimitUsd: 100,
        weightedBorrowsUsd: 0,
        depositedAmountUsd: 100,
        borrowedAmountUsd: 0,
        deposits: [],
        borrows: []
      }
    ]
  };
}

function existingCollateralPositionSnapshot(config: AppConfig): PositionSnapshot {
  return {
    id: 'positions-existing',
    runId: 'positions-existing',
    walletAddress: config.agent.walletAddress,
    capturedAt: new Date().toISOString(),
    protocols: [
      {
        protocol: 'navi',
        healthFactor: Number.POSITIVE_INFINITY,
        borrowLimitUsd: 20,
        weightedBorrowsUsd: 0,
        depositedAmountUsd: 20,
        borrowedAmountUsd: 0,
        deposits: [
          {
            protocol: 'navi',
            asset: 'USDC',
            coinType: 'usdc-coin',
            rawAmount: '20000000',
            amountUsd: 20,
            side: 'deposit'
          }
        ],
        borrows: []
      }
    ]
  };
}

function mockClients(
  input: {
    suilendHealthFactor?: number;
    suilendBorrowUsd?: number;
    naviDepositUsd?: number;
    naviBorrowLimitUsd?: number;
  } = {}
): Clients {
  const protocolClient = (protocol: LendingProtocol) => ({
    name: protocol,
    enabled: true,
    requiresObligationForWrite: false,
    resolveCoinType: (asset: string) => `${asset.toLowerCase()}-coin`,
    isAssetAllowed: () => true,
    getMarkets: async () => ({
      markets:
        protocol === 'suilend'
          ? [
              {
                symbol: 'USDC',
                coinType: 'usdc-coin',
                decimals: 6,
                supplyApr: 2,
                borrowApr: 0,
                totalApr: 2,
                price: 1,
                allowed: true
              },
              {
                symbol: 'SUI',
                coinType: 'sui-coin',
                decimals: 9,
                supplyApr: 1,
                borrowApr: 4,
                totalApr: 1,
                price: 1,
                allowed: true
              }
            ]
          : [
              {
                symbol: 'SUI',
                coinType: 'sui-coin',
                decimals: 9,
                supplyApr: protocol === 'navi' ? 7 : 6,
                borrowApr: 5,
                totalApr: protocol === 'navi' ? 7 : 6,
                price: 1,
                allowed: true
              }
            ]
    }),
    getPositions: async () => normalizedPositions(protocol, input),
    executeSupply: async () => ({ digest: `digest-${protocol}-supply`, success: true }),
    executeWithdraw: async () => ({ digest: `digest-${protocol}-withdraw`, success: true }),
    executeBorrow: async () => ({ digest: `digest-${protocol}-borrow`, success: true }),
    executeRepay: async () => ({ digest: `digest-${protocol}-repay`, success: true }),
    simulateHealthFactorAfterBorrow: async () => 2
  });

  return {
    suiExecution: {
      assertWalletMatches: async () => ({ address: '0x1' })
    },
    suilend: protocolClient('suilend'),
    navi: protocolClient('navi'),
    scallop: protocolClient('scallop'),
    walrusBlob: {
      storeString: async (_value: string) => ({
        blobId: `blob-${Date.now()}`,
        url: 'walrus://blob',
        newlyCreated: true
      })
    }
  } as unknown as Clients;
}

function normalizedPositions(
  protocol: LendingProtocol,
  input: {
    suilendHealthFactor?: number;
    suilendBorrowUsd?: number;
    naviDepositUsd?: number;
    naviBorrowLimitUsd?: number;
  }
): NormalizedPositions {
  const borrowedAmountUsd = protocol === 'suilend' ? (input.suilendBorrowUsd ?? 0) : 0;
  const naviDepositUsd = protocol === 'navi' ? (input.naviDepositUsd ?? 0) : 0;
  return {
    protocol,
    healthFactor:
      protocol === 'suilend'
        ? (input.suilendHealthFactor ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY,
    borrowLimitUsd: protocol === 'suilend' ? 100 : protocol === 'navi' ? (input.naviBorrowLimitUsd ?? 0) : 0,
    weightedBorrowsUsd: borrowedAmountUsd,
    depositedAmountUsd: protocol === 'suilend' ? 100 : naviDepositUsd,
    borrowedAmountUsd,
    deposits:
      naviDepositUsd > 0
        ? [
            {
              symbol: 'USDC',
              coinType: 'usdc-coin',
              amount: String(Math.floor(naviDepositUsd * 1_000_000)),
              amountUsd: naviDepositUsd,
              side: 'deposit'
            }
          ]
        : [],
    borrows:
      borrowedAmountUsd > 0
        ? [
            {
              symbol: 'SUI',
              coinType: 'sui-coin',
              amount: '10000000000',
              amountUsd: borrowedAmountUsd,
              side: 'borrow'
            }
          ]
        : []
  };
}

function tickOptions(config: AppConfig, ledgerStore: StrategyLedgerStore, clients: Clients) {
  return {
    role: 'coordinator' as const,
    config,
    clients,
    logger: quietLogger(),
    ledgerStore
  };
}

function tempLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-ledger-test-'));
  return path.join(dir, 'strategy-ledger.json');
}

function oldIso(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (!item) {
    throw new Error('Expected fixture item');
  }
  return item;
}

function quietLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
