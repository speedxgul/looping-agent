import type {
  AppConfig,
  Clients,
  LendingProtocol,
  LendingProtocolClient,
  Logger,
  NormalizedPosition,
  NormalizedPositions,
  StrategyExecutionActor,
  SubagentRole
} from '../types.js';
import type {
  AcceptedPlan,
  ExecutionLegReceipt,
  LoopStrategyProposal,
  MarketRate,
  MarketSnapshot,
  PositionSnapshot,
  ProtocolPositionSnapshot,
  StrategyLedgerStore
} from './strategyLedger.js';
import {
  activeLoopOpeningPlans,
  archiveLedgerRecord,
  isFresh,
  latestMarketSnapshot,
  latestPositionSnapshot,
  recordHeartbeat,
  staleSubagents
} from './strategyLedger.js';

export interface SubagentTickOptions {
  role: SubagentRole;
  config: AppConfig;
  clients: Clients;
  logger: Logger;
  ledgerStore: StrategyLedgerStore;
}

export interface ProposalValidationResult {
  allowed: boolean;
  reason: string;
}

const PROTOCOLS: LendingProtocol[] = ['suilend', 'navi', 'scallop'];

export async function runSubagentTick(options: SubagentTickOptions): Promise<void> {
  const runId = `${options.role}-${new Date().toISOString()}`;
  await options.ledgerStore.update((ledger) => {
    recordHeartbeat(ledger, options.role, { runId, status: 'running', enabled: true });
  });

  try {
    switch (options.role) {
      case 'rate-scout':
        await runRateScout(options, runId);
        break;
      case 'position-risk':
        await runPositionRisk(options, runId);
        break;
      case 'loop-strategist':
        await runLoopStrategist(options, runId);
        break;
      case 'coordinator':
        await runCoordinator(options, runId);
        break;
      case 'executor':
        await runExecutor(options, runId);
        break;
      case 'unwind-guard':
        await runUnwindGuard(options, runId);
        break;
    }

    await options.ledgerStore.update((ledger) => {
      recordHeartbeat(ledger, options.role, { runId, status: 'ok', enabled: true });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await options.ledgerStore.update((ledger) => {
      recordHeartbeat(ledger, options.role, { runId, status: 'error', enabled: true, message });
    });
    throw error;
  }
}

export async function runRateScout(options: SubagentTickOptions, runId: string): Promise<void> {
  const rates: MarketRate[] = [];

  await Promise.all(
    PROTOCOLS.map(async (protocol) => {
      const client = protocolClient(options.clients, protocol);
      if (!client.enabled || !options.config.sui.protocols[protocol].enabled) {
        return;
      }

      try {
        const markets = await client.getMarkets();
        for (const market of markets.markets) {
          const asset = market.symbol.toLowerCase();
          if (
            asset !== options.config.loopStrategy.collateralAsset &&
            asset !== options.config.loopStrategy.borrowAsset
          ) {
            continue;
          }
          rates.push({
            protocol,
            asset: market.symbol.toUpperCase(),
            coinType: market.coinType,
            supplyApr: market.supplyApr,
            borrowApr: market.borrowApr,
            priceUsd: market.price
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn('Rate scout protocol read failed', { protocol, error: message });
      }
    })
  );

  const snapshot: MarketSnapshot = {
    id: `market-${runId}`,
    runId,
    capturedAt: new Date().toISOString(),
    rates: rates.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.asset.localeCompare(b.asset))
  };

  await options.ledgerStore.update((ledger) => {
    ledger.marketSnapshots.unshift(snapshot);
  });
}

export async function runPositionRisk(options: SubagentTickOptions, runId: string): Promise<void> {
  const protocols: ProtocolPositionSnapshot[] = [];

  await Promise.all(
    PROTOCOLS.map(async (protocol) => {
      const client = protocolClient(options.clients, protocol);
      if (!client.enabled || !options.config.sui.protocols[protocol].enabled) {
        return;
      }

      try {
        protocols.push(
          normalizeProtocolPositions(await client.getPositions(options.config.agent.walletAddress))
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn('Position-risk protocol read failed', { protocol, error: message });
      }
    })
  );

  const snapshot: PositionSnapshot = {
    id: `positions-${runId}`,
    runId,
    walletAddress: options.config.agent.walletAddress.toLowerCase(),
    capturedAt: new Date().toISOString(),
    protocols: protocols.sort((a, b) => a.protocol.localeCompare(b.protocol))
  };

  await options.ledgerStore.update((ledger) => {
    ledger.positionSnapshots.unshift(snapshot);
  });
}

export async function runLoopStrategist(options: SubagentTickOptions, runId: string): Promise<void> {
  if (!options.config.loopStrategy.enabled) {
    return;
  }

  await options.ledgerStore.update((ledger) => {
    const market = latestMarketSnapshot(ledger);
    const positions = latestPositionSnapshot(ledger);
    const proposal = buildLoopProposal({
      config: options.config,
      runId,
      market,
      positions,
      existingProposalCount: ledger.strategyProposals.length
    });

    if (!proposal) {
      return;
    }

    const validation = validateLoopProposal(proposal, ledger, options.config);
    if (!validation.allowed) {
      proposal.status = 'rejected';
      proposal.rejectionReason = validation.reason;
    }
    ledger.strategyProposals.unshift(proposal);
  });
}

export async function runCoordinator(options: SubagentTickOptions, _runId: string): Promise<void> {
  await options.ledgerStore.update(async (ledger) => {
    for (const proposal of ledger.strategyProposals) {
      if (proposal.status !== 'open' || new Date(proposal.expiresAt).getTime() <= Date.now()) {
        if (proposal.status === 'open') {
          proposal.status = 'expired';
          proposal.rejectionReason = 'Proposal expired';
        }
      }
    }

    const stale = staleSubagents(ledger, options.config.loopStrategy.staleHeartbeatMs);
    if (stale.length > 0) {
      options.logger.warn('Coordinator observed stale subagent heartbeat', {
        roles: stale.map((heartbeat) => heartbeat.role)
      });
    }

    if (activeLoopOpeningPlans(ledger).length > 0) {
      return;
    }

    const proposal = ledger.strategyProposals.find((candidate) => candidate.status === 'open');
    if (!proposal) {
      return;
    }

    const policy = {
      ...validateLoopProposal(proposal, ledger, options.config),
      checkedAt: new Date().toISOString()
    };

    if (!policy.allowed) {
      proposal.status = 'rejected';
      proposal.rejectionReason = policy.reason;
      return;
    }

    proposal.status = 'accepted';
    const plan: AcceptedPlan = {
      id: `plan-${proposal.id}`,
      proposalId: proposal.id,
      acceptedAt: new Date().toISOString(),
      status: 'accepted',
      policy
    };
    ledger.acceptedPlans.unshift(plan);
    await archiveLedgerRecord(ledger, options.clients.walrusBlob, options.logger, 'accepted_plan', plan.id, {
      plan,
      proposal
    });
  });
}

export async function runExecutor(options: SubagentTickOptions, runId: string): Promise<void> {
  await claimAndExecuteAcceptedPlan({ ...options, actor: 'executor', runId });
}

export async function claimAndExecuteAcceptedPlan(
  options: SubagentTickOptions & {
    actor: StrategyExecutionActor;
    runId: string;
    planId?: string;
  }
): Promise<Record<string, unknown>> {
  let plan: AcceptedPlan | undefined;
  let proposal: LoopStrategyProposal | undefined;
  const now = Date.now();
  const claimExpiresAt = new Date(now + options.config.loopStrategy.executionClaimTtlMs).toISOString();

  await options.ledgerStore.update((ledger) => {
    const candidate = options.planId
      ? ledger.acceptedPlans.find((entry) => entry.id === options.planId)
      : ledger.acceptedPlans.find((entry) => entry.status === 'accepted' || claimExpired(entry, now));
    if (!candidate) {
      return;
    }
    if (candidate.status !== 'accepted' && !claimExpired(candidate, now)) {
      return;
    }

    const foundProposal = ledger.strategyProposals.find((entry) => entry.id === candidate.proposalId);
    if (!foundProposal) {
      candidate.status = 'failed';
      candidate.failureReason = 'Accepted proposal is missing';
      return;
    }

    candidate.status = 'executing';
    candidate.executorRunId = options.runId;
    candidate.claimedBy = options.actor;
    candidate.claimedAt = new Date(now).toISOString();
    candidate.claimExpiresAt = claimExpiresAt;
    candidate.executionFingerprint = executionFingerprint(foundProposal);
    plan = { ...candidate };
    proposal = foundProposal;
  });

  if (!plan || !proposal) {
    return { ok: true, claimed: false, reason: 'No accepted plan available to claim' };
  }

  const executionPlan = plan;
  const executionProposal = proposal;
  const ledger = options.ledgerStore.load();
  const gate = validateExecutorGate(executionProposal, ledger, options.config);
  if (!gate.allowed) {
    await options.ledgerStore.update((updated) => {
      const current = updated.acceptedPlans.find((candidate) => candidate.id === executionPlan.id);
      if (current && current.claimedBy === options.actor && current.executorRunId === options.runId) {
        current.status = 'failed';
        current.failureReason = gate.reason;
      }
    });
    return { ok: false, claimed: true, blocked: true, reason: gate.reason };
  }

  const beforeHealthFactor = latestPositionSnapshot(ledger)?.protocols.find(
    (positions) => positions.protocol === executionProposal.collateralProtocol
  )?.healthFactor;

  const legs = executionLegs(executionProposal, options.config.runtime.dryRun);
  let status: 'planned' | 'confirmed' | 'failed' = options.config.runtime.dryRun ? 'planned' : 'confirmed';
  let error: string | undefined;

  if (!options.config.runtime.dryRun) {
    try {
      await options.clients.suiExecution.assertWalletMatches();
      const collateralClient = protocolClient(options.clients, executionProposal.collateralProtocol);
      const targetClient = protocolClient(options.clients, executionProposal.supplyTargetProtocol);

      if (executionProposal.proposalType !== 'borrow_against_existing_collateral') {
        const supplied = await collateralClient.executeSupply({
          coinType: collateralClient.resolveCoinType(executionProposal.collateralAsset),
          asset: executionProposal.collateralAsset,
          rawAmount: executionProposal.rawCollateralAmount
        });
        const supplyIndex = legs.findIndex(
          (leg) => leg.action === 'supply' && leg.asset === executionProposal.collateralAsset
        );
        legs[supplyIndex] = confirmedLeg(legs[supplyIndex], supplied.digest);
      }

      const positions = await collateralClient.getPositions(options.config.agent.walletAddress);
      const borrowed = await collateralClient.executeBorrow({
        coinType: collateralClient.resolveCoinType(executionProposal.borrowAsset),
        asset: executionProposal.borrowAsset,
        rawAmount: executionProposal.rawBorrowAmount,
        positions
      });
      const borrowIndex = legs.findIndex((leg) => leg.action === 'borrow');
      legs[borrowIndex] = confirmedLeg(legs[borrowIndex], borrowed.digest);

      const targetSupplied = await targetClient.executeSupply({
        coinType: targetClient.resolveCoinType(executionProposal.borrowAsset),
        asset: executionProposal.borrowAsset,
        rawAmount: executionProposal.rawBorrowAmount
      });
      const targetSupplyIndex = legs.findIndex(
        (leg) => leg.action === 'supply' && leg.protocol === executionProposal.supplyTargetProtocol
      );
      legs[targetSupplyIndex] = confirmedLeg(legs[targetSupplyIndex], targetSupplied.digest);
    } catch (caught: unknown) {
      status = 'failed';
      error = caught instanceof Error ? caught.message : String(caught);
      for (const leg of legs) {
        if (leg.status === 'submitted') {
          leg.status = 'failed';
        }
      }
    }
  }

  const completedAt = new Date().toISOString();
  const receipt = {
    id: `receipt-${executionPlan.id}-${Date.now()}`,
    planId: executionPlan.id,
    proposalId: executionProposal.id,
    executorRunId: options.runId,
    executedBy: options.actor,
    dryRun: options.config.runtime.dryRun,
    startedAt: executionPlan.claimedAt ?? completedAt,
    completedAt,
    status,
    legs,
    ...(beforeHealthFactor !== undefined ? { beforeHealthFactor } : {}),
    ...(status === 'failed' && error ? { error } : {})
  };

  await options.ledgerStore.update(async (updated) => {
    const current = updated.acceptedPlans.find((candidate) => candidate.id === executionPlan.id);
    if (!current || current.claimedBy !== options.actor || current.executorRunId !== options.runId) {
      return;
    }

    updated.executionReceipts.unshift(receipt);
    current.status = status === 'failed' ? 'failed' : 'executed';
    current.executionReceiptId = receipt.id;
    if (error) {
      current.failureReason = error;
    }

    if (status !== 'failed') {
      updated.loopPositions.unshift({
        id: `loop-${executionPlan.id}`,
        planId: executionPlan.id,
        proposalId: executionProposal.id,
        openedAt: completedAt,
        status: options.config.runtime.dryRun ? 'opening' : 'active',
        collateralProtocol: executionProposal.collateralProtocol,
        supplyTargetProtocol: executionProposal.supplyTargetProtocol,
        collateralAsset: executionProposal.collateralAsset,
        borrowAsset: executionProposal.borrowAsset,
        rawCollateralAmount: executionProposal.rawCollateralAmount,
        rawBorrowAmount: executionProposal.rawBorrowAmount,
        borrowUsd: executionProposal.borrowUsd,
        depth: 1
      });
    }

    await archiveLedgerRecord(
      updated,
      options.clients.walrusBlob,
      options.logger,
      'execution_receipt',
      receipt.id,
      receipt
    );
  });

  return {
    ok: status !== 'failed',
    claimed: true,
    dryRun: options.config.runtime.dryRun,
    planId: executionPlan.id,
    proposalId: executionProposal.id,
    receiptId: receipt.id,
    status,
    ...(error ? { error } : {})
  };
}

export async function runUnwindGuard(options: SubagentTickOptions, _runId: string): Promise<void> {
  await options.ledgerStore.update(async (ledger) => {
    const snapshot = latestPositionSnapshot(ledger);
    if (!snapshot) {
      return;
    }

    const critical = snapshot.protocols.find(
      (positions) =>
        positions.borrows.length > 0 &&
        positions.healthFactor <= options.config.loopStrategy.criticalHealthFactor
    );
    if (!critical) {
      return;
    }

    const existing = ledger.riskLocks.find(
      (lock) => lock.active && lock.protocol === critical.protocol && lock.severity === 'critical'
    );
    if (existing) {
      existing.healthFactor = critical.healthFactor;
      existing.reason = criticalRiskReason(
        critical.healthFactor,
        options.config.loopStrategy.criticalHealthFactor
      );
      return;
    }

    const lock = {
      id: `risk-lock-${critical.protocol}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      role: options.role,
      severity: 'critical' as const,
      reason: criticalRiskReason(critical.healthFactor, options.config.loopStrategy.criticalHealthFactor),
      active: true,
      protocol: critical.protocol,
      healthFactor: critical.healthFactor
    };
    ledger.riskLocks.unshift(lock);
    for (const loop of ledger.loopPositions) {
      if (loop.status === 'active') {
        loop.status = 'unwinding';
        loop.unwindStatus = lock.reason;
      }
    }
    await archiveLedgerRecord(ledger, options.clients.walrusBlob, options.logger, 'risk_lock', lock.id, lock);
  });
}

export function buildLoopProposal(input: {
  config: AppConfig;
  runId: string;
  market: MarketSnapshot | null;
  positions: PositionSnapshot | null;
  existingProposalCount?: number;
}): LoopStrategyProposal | null {
  const { config, market, positions } = input;
  if (!market || !positions) {
    return null;
  }

  const collateralAsset = config.loopStrategy.collateralAsset.toUpperCase();
  const borrowAsset = config.loopStrategy.borrowAsset.toUpperCase();
  if (collateralAsset !== 'USDC' || borrowAsset !== 'SUI') {
    return null;
  }

  if (config.loopStrategy.useExistingCollateral) {
    const existing = buildExistingCollateralProposal(input);
    if (existing) {
      return existing;
    }
  }

  const collateralMarkets = market.rates.filter((rate) => rate.asset.toUpperCase() === 'USDC');
  const borrowMarkets = market.rates.filter((rate) => rate.asset.toUpperCase() === 'SUI');
  const collateralProtocol = collateralMarkets[0]?.protocol;
  if (!collateralProtocol) {
    return null;
  }

  const borrowMarket = borrowMarkets.find((rate) => rate.protocol === collateralProtocol);
  if (!borrowMarket) {
    return null;
  }

  const target = borrowMarkets
    .filter((rate) => rate.protocol !== collateralProtocol)
    .sort((a, b) => b.supplyApr - a.supplyApr)[0];
  if (!target) {
    return null;
  }

  const collateralUsd = config.loopStrategy.maxCollateralUsd;
  const borrowUsd = config.loopStrategy.maxBorrowUsd;
  const rawCollateralAmount = Math.max(1, Math.floor(collateralUsd * 1_000_000)).toString();
  const suiPrice = borrowMarket.priceUsd > 0 ? borrowMarket.priceUsd : 1;
  const rawBorrowAmount = Math.max(1, Math.floor((borrowUsd / suiPrice) * 1_000_000_000)).toString();
  const current = positions.protocols.find((protocol) => protocol.protocol === collateralProtocol);
  const projectedBorrowLimit = (current?.borrowLimitUsd ?? 0) + collateralUsd * 0.7;
  const projectedWeightedBorrow = (current?.weightedBorrowsUsd ?? 0) + borrowUsd;
  const projectedHealthFactor =
    projectedWeightedBorrow > 0 ? projectedBorrowLimit / projectedWeightedBorrow : Number.POSITIVE_INFINITY;
  const projectedNetAprBps = Math.round((target.supplyApr - borrowMarket.borrowApr) * 100);
  const now = Date.now();

  return {
    id: `proposal-${input.runId}-${input.existingProposalCount ?? 0}`,
    runId: input.runId,
    proposerRole: 'loop-strategist',
    proposalType: 'open_loop',
    createdBy: 'loop-strategist',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.loopStrategy.proposalTtlMs).toISOString(),
    status: 'open',
    collateralAsset: 'USDC',
    borrowAsset: 'SUI',
    collateralProtocol,
    borrowProtocol: collateralProtocol,
    supplyTargetProtocol: target.protocol,
    rawCollateralAmount,
    rawBorrowAmount,
    collateralUsd,
    borrowUsd,
    projectedHealthFactor,
    projectedNetAprBps,
    netAprBps: projectedNetAprBps,
    targetSupplyAsset: 'SUI',
    rationale: `Open a fresh ${collateralAsset} collateral loop, borrow ${borrowAsset}, and supply ${borrowAsset} to ${target.protocol}.`,
    unwindPath: [
      `withdraw ${borrowAsset} from ${target.protocol}`,
      `repay ${borrowAsset} on ${collateralProtocol}`,
      `withdraw ${collateralAsset} from ${collateralProtocol}`
    ],
    marketSnapshotId: market.id,
    positionSnapshotId: positions.id
  };
}

function buildExistingCollateralProposal(input: {
  config: AppConfig;
  runId: string;
  market: MarketSnapshot | null;
  positions: PositionSnapshot | null;
  existingProposalCount?: number;
}): LoopStrategyProposal | null {
  const { config, market, positions } = input;
  if (!market || !positions) {
    return null;
  }

  const collateral = positions.protocols
    .flatMap((protocol) =>
      protocol.deposits
        .filter((deposit) => deposit.asset.toUpperCase() === 'USDC' && deposit.amountUsd > 0)
        .map((deposit) => ({ protocol, deposit }))
    )
    .sort((a, b) => b.deposit.amountUsd - a.deposit.amountUsd)[0];
  if (!collateral) {
    return null;
  }

  const borrowMarket = market.rates.find(
    (rate) => rate.protocol === collateral.protocol.protocol && rate.asset.toUpperCase() === 'SUI'
  );
  if (!borrowMarket) {
    return null;
  }

  const target = market.rates
    .filter((rate) => rate.asset.toUpperCase() === 'SUI' && rate.protocol !== collateral.protocol.protocol)
    .sort((a, b) => b.supplyApr - a.supplyApr)[0];
  if (!target) {
    return null;
  }

  const borrowUsd = plannedBorrowUsd(collateral.protocol, config);
  if (borrowUsd <= 0) {
    return null;
  }

  const projectedWeightedBorrow = collateral.protocol.weightedBorrowsUsd + borrowUsd;
  const borrowLimitUsd = effectiveBorrowLimitUsd(collateral.protocol);
  const projectedHealthFactor =
    projectedWeightedBorrow > 0 ? borrowLimitUsd / projectedWeightedBorrow : Number.POSITIVE_INFINITY;
  const projectedNetAprBps = Math.round((target.supplyApr - borrowMarket.borrowApr) * 100);
  const suiPrice = borrowMarket.priceUsd > 0 ? borrowMarket.priceUsd : 1;
  const rawBorrowAmount = Math.max(1, Math.floor((borrowUsd / suiPrice) * 1_000_000_000)).toString();
  const now = Date.now();
  const collateralProtocol = collateral.protocol.protocol;

  return {
    id: `proposal-${input.runId}-${input.existingProposalCount ?? 0}`,
    runId: input.runId,
    proposerRole: 'loop-strategist',
    proposalType: 'borrow_against_existing_collateral',
    createdBy: 'loop-strategist',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.loopStrategy.proposalTtlMs).toISOString(),
    status: 'open',
    collateralAsset: 'USDC',
    borrowAsset: 'SUI',
    collateralProtocol,
    borrowProtocol: collateralProtocol,
    supplyTargetProtocol: target.protocol,
    rawCollateralAmount: collateral.deposit.rawAmount,
    rawBorrowAmount,
    collateralUsd: collateral.deposit.amountUsd,
    borrowUsd,
    projectedHealthFactor,
    projectedNetAprBps,
    netAprBps: projectedNetAprBps,
    sourcePositionId: `${collateralProtocol}:${collateral.deposit.coinType}:${collateral.deposit.rawAmount}`,
    targetSupplyAsset: 'SUI',
    rationale: `Use existing ${collateral.deposit.amountUsd.toFixed(2)} USDC collateral on ${collateralProtocol}, borrow SUI, and supply SUI to ${target.protocol}.`,
    unwindPath: [
      `withdraw SUI from ${target.protocol}`,
      `repay SUI on ${collateralProtocol}`,
      `leave existing USDC collateral on ${collateralProtocol}`
    ],
    marketSnapshotId: market.id,
    positionSnapshotId: positions.id
  };
}

export function validateLoopProposal(
  proposal: LoopStrategyProposal,
  ledger: {
    marketSnapshots: MarketSnapshot[];
    positionSnapshots: PositionSnapshot[];
    riskLocks: Array<{ active: boolean }>;
    acceptedPlans: Array<{ status: string }>;
    loopPositions?: Array<{ status: string }>;
  },
  config: AppConfig,
  now = Date.now()
): ProposalValidationResult {
  if (!config.loopStrategy.enabled) {
    return deny('Loop strategy is disabled');
  }
  if (config.loopStrategy.maxDepth !== 1) {
    return deny('Only LOOP_MAX_DEPTH=1 is supported');
  }
  if (proposal.collateralAsset !== 'USDC' || proposal.borrowAsset !== 'SUI') {
    return deny('Only USDC collateral and SUI borrow proposals are supported');
  }
  if (proposal.borrowProtocol !== proposal.collateralProtocol) {
    return deny('Borrow protocol must match collateral protocol');
  }
  if (proposal.supplyTargetProtocol === proposal.collateralProtocol) {
    return deny('SUI supply target must be a different protocol from the collateral protocol');
  }
  if (proposal.proposalType === 'borrow_against_existing_collateral' && !proposal.sourcePositionId) {
    return deny('Existing-collateral proposal is missing sourcePositionId');
  }
  if (new Date(proposal.expiresAt).getTime() <= now) {
    return deny('Proposal expired');
  }
  if (proposal.projectedHealthFactor < config.loopStrategy.minHealthFactor) {
    return deny(
      `Projected health factor ${proposal.projectedHealthFactor.toFixed(3)} is below LOOP_MIN_HEALTH_FACTOR (${config.loopStrategy.minHealthFactor})`
    );
  }
  if (proposal.projectedNetAprBps < config.loopStrategy.minNetAprBps) {
    return deny(
      `Projected net APR ${proposal.projectedNetAprBps}bps is below LOOP_MIN_NET_APR_BPS (${config.loopStrategy.minNetAprBps})`
    );
  }
  if (proposal.borrowUsd > config.loopStrategy.maxBorrowUsd) {
    return deny(`Borrow amount exceeds LOOP_MAX_BORROW_USD (${config.loopStrategy.maxBorrowUsd})`);
  }
  if (
    proposal.proposalType === 'open_loop' &&
    proposal.collateralUsd > config.loopStrategy.maxCollateralUsd
  ) {
    return deny(
      `Collateral amount exceeds LOOP_MAX_COLLATERAL_USD (${config.loopStrategy.maxCollateralUsd})`
    );
  }
  if (ledger.riskLocks.some((lock) => lock.active)) {
    return deny('Active risk lock blocks new loop plans');
  }
  if (activeLoopOpeningPlans(ledger as never).length > 0) {
    return deny('Another loop-opening plan is already active');
  }
  if (
    ledger.loopPositions?.some((position) => position.status === 'active' || position.status === 'opening')
  ) {
    return deny('A single-depth loop is already active');
  }

  const market = ledger.marketSnapshots.find((snapshot) => snapshot.id === proposal.marketSnapshotId);
  if (!market || !isFresh(market.capturedAt, config.loopStrategy.staleSnapshotMs, now)) {
    return deny('Market snapshot is stale or missing');
  }
  const positions = ledger.positionSnapshots.find((snapshot) => snapshot.id === proposal.positionSnapshotId);
  if (!positions || !isFresh(positions.capturedAt, config.loopStrategy.staleSnapshotMs, now)) {
    return deny('Position snapshot is stale or missing');
  }

  return { allowed: true, reason: 'Loop proposal satisfies deterministic policy' };
}

export function validateExecutorGate(
  proposal: LoopStrategyProposal,
  ledger: {
    marketSnapshots: MarketSnapshot[];
    positionSnapshots: PositionSnapshot[];
    riskLocks: Array<{ active: boolean }>;
    acceptedPlans: Array<{ status: string }>;
  },
  config: AppConfig,
  now = Date.now()
): ProposalValidationResult {
  if (!config.loopStrategy.enabled) {
    return deny('Loop strategy is disabled');
  }
  if (!config.runtime.dryRun) {
    if (!config.sui.enableBorrow) {
      return deny('ENABLE_SUI_BORROW must be true for live loop execution');
    }
    if (!config.loopStrategy.executionEnabled) {
      return deny('LOOP_EXECUTION_ENABLED must be true for live loop execution');
    }
  }

  const proposalPolicy = validateLoopProposal(proposal, { ...ledger, acceptedPlans: [] }, config, now);
  if (!proposalPolicy.allowed) {
    return proposalPolicy;
  }

  return { allowed: true, reason: 'Executor gate passed' };
}

function normalizeProtocolPositions(positions: NormalizedPositions): ProtocolPositionSnapshot {
  return {
    protocol: positions.protocol,
    healthFactor: positions.healthFactor,
    borrowLimitUsd: positions.borrowLimitUsd,
    weightedBorrowsUsd: positions.weightedBorrowsUsd,
    depositedAmountUsd: positions.depositedAmountUsd,
    borrowedAmountUsd: positions.borrowedAmountUsd,
    ...(positions.obligationId !== undefined ? { obligationId: positions.obligationId } : {}),
    ...(positions.obligationOwnerCapId !== undefined
      ? { obligationOwnerCapId: positions.obligationOwnerCapId }
      : {}),
    ...(positions.obligationKeyId !== undefined ? { obligationKeyId: positions.obligationKeyId } : {}),
    deposits: positions.deposits.map((leg) => normalizePositionLeg(positions.protocol, leg)),
    borrows: positions.borrows.map((leg) => normalizePositionLeg(positions.protocol, leg))
  };
}

function normalizePositionLeg(protocol: LendingProtocol, leg: NormalizedPosition) {
  return {
    protocol,
    asset: leg.symbol.toUpperCase(),
    coinType: leg.coinType,
    rawAmount: leg.amount,
    amountUsd: leg.amountUsd,
    side: leg.side
  };
}

function protocolClient(clients: Clients, protocol: LendingProtocol): LendingProtocolClient {
  return clients[protocol] as unknown as LendingProtocolClient;
}

function claimExpired(plan: AcceptedPlan, now = Date.now()): boolean {
  return (
    plan.status === 'executing' &&
    Boolean(plan.claimExpiresAt) &&
    new Date(plan.claimExpiresAt ?? '').getTime() <= now
  );
}

function executionFingerprint(proposal: LoopStrategyProposal): string {
  return [
    proposal.proposalType,
    proposal.collateralProtocol,
    proposal.supplyTargetProtocol,
    proposal.collateralAsset,
    proposal.borrowAsset,
    proposal.rawCollateralAmount,
    proposal.rawBorrowAmount,
    proposal.sourcePositionId ?? ''
  ].join(':');
}

function executionLegs(proposal: LoopStrategyProposal, dryRun: boolean): ExecutionLegReceipt[] {
  const status = dryRun ? 'planned' : 'submitted';
  const legs: ExecutionLegReceipt[] = [];

  if (proposal.proposalType !== 'borrow_against_existing_collateral') {
    legs.push({
      protocol: proposal.collateralProtocol,
      action: 'supply',
      asset: proposal.collateralAsset,
      rawAmount: proposal.rawCollateralAmount,
      status
    });
  }

  legs.push(
    {
      protocol: proposal.borrowProtocol,
      action: 'borrow',
      asset: proposal.borrowAsset,
      rawAmount: proposal.rawBorrowAmount,
      status
    },
    {
      protocol: proposal.supplyTargetProtocol,
      action: 'supply',
      asset: proposal.borrowAsset,
      rawAmount: proposal.rawBorrowAmount,
      status
    }
  );

  return legs;
}

function plannedBorrowUsd(positions: ProtocolPositionSnapshot, config: AppConfig): number {
  const borrowLimitUsd = effectiveBorrowLimitUsd(positions);
  if (borrowLimitUsd <= 0) {
    return 0;
  }

  const capacityByFraction = Math.max(
    0,
    (borrowLimitUsd - positions.weightedBorrowsUsd) * config.loopStrategy.borrowCapacityFraction
  );
  const capacityByHealth =
    borrowLimitUsd / config.loopStrategy.minHealthFactor - positions.weightedBorrowsUsd;
  return Math.max(0, Math.min(config.loopStrategy.maxBorrowUsd, capacityByFraction, capacityByHealth));
}

function effectiveBorrowLimitUsd(positions: ProtocolPositionSnapshot): number {
  if (positions.borrowLimitUsd > 0) {
    return positions.borrowLimitUsd;
  }

  if (positions.depositedAmountUsd <= 0 || positions.borrowedAmountUsd > 0) {
    return 0;
  }

  // Some protocols do not expose borrow capacity before the first borrow. Use a
  // conservative 50% collateral-derived fallback; live execution still simulates
  // projected HF where the protocol client supports it.
  return positions.depositedAmountUsd * 0.5;
}

function confirmedLeg(leg: ExecutionLegReceipt | undefined, digest: string): ExecutionLegReceipt {
  if (!leg) {
    throw new Error('Missing execution leg');
  }

  return { ...leg, status: 'confirmed', digest };
}

function criticalRiskReason(healthFactor: number, floor: number): string {
  return `Health factor ${healthFactor.toFixed(3)} is at or below LOOP_CRITICAL_HEALTH_FACTOR (${floor})`;
}

function deny(reason: string): ProposalValidationResult {
  return { allowed: false, reason };
}
