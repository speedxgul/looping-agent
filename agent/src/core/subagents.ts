import type {
  AppConfig,
  Clients,
  LendingProtocol,
  LendingProtocolClient,
  Logger,
  NormalizedPosition,
  NormalizedPositions,
  OpenAIInputItem,
  OpenAIResponse,
  StrategyExecutionActor,
  SuiBalancesResponse,
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
  StrategyLedgerStore,
  WalrusLedgerArchive
} from './strategyLedger.js';
import {
  activeLoopOpeningPlans,
  appendWalrusArchive,
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

interface LedgerArchiveRequest {
  kind: WalrusLedgerArchive['kind'];
  recordId: string;
  value: unknown;
}

/** A human-readable summary of what a subagent actually did during one tick. */
export type SubagentTickSummary = Record<string, unknown>;

const PROTOCOLS: LendingProtocol[] = ['suilend', 'navi', 'scallop'];

export async function runSubagentTick(options: SubagentTickOptions): Promise<SubagentTickSummary> {
  const runId = `${options.role}-${new Date().toISOString()}`;
  await options.ledgerStore.update((ledger) => {
    recordHeartbeat(ledger, options.role, { runId, status: 'running', enabled: true });
  });

  try {
    let summary: SubagentTickSummary = {};
    switch (options.role) {
      case 'rate-scout':
        summary = await runRateScout(options, runId);
        break;
      case 'position-risk':
        summary = await runPositionRisk(options, runId);
        break;
      case 'loop-strategist':
        summary = await runLoopStrategist(options, runId);
        break;
      case 'coordinator':
        summary = await runCoordinator(options, runId);
        break;
      case 'executor':
        summary = await runExecutor(options, runId);
        break;
      case 'unwind-guard':
        summary = await runUnwindGuard(options, runId);
        break;
    }

    await options.ledgerStore.update((ledger) => {
      recordHeartbeat(ledger, options.role, { runId, status: 'ok', enabled: true });
    });
    return summary;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await options.ledgerStore.update((ledger) => {
      recordHeartbeat(ledger, options.role, { runId, status: 'error', enabled: true, message });
    });
    throw error;
  }
}

export async function runRateScout(
  options: SubagentTickOptions,
  runId: string
): Promise<SubagentTickSummary> {
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

  return {
    action: rates.length > 0 ? 'captured_market_snapshot' : 'no_rates_found',
    snapshotId: snapshot.id,
    rateCount: rates.length,
    protocols: [...new Set(rates.map((rate) => rate.protocol))],
    assets: [...new Set(rates.map((rate) => rate.asset))]
  };
}

export async function runPositionRisk(
  options: SubagentTickOptions,
  runId: string
): Promise<SubagentTickSummary> {
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

  return {
    action: protocols.length > 0 ? 'captured_position_snapshot' : 'no_positions_found',
    snapshotId: snapshot.id,
    protocols: protocols.map((entry) => ({
      protocol: entry.protocol,
      healthFactor: entry.healthFactor,
      deposits: entry.deposits.length,
      borrows: entry.borrows.length,
      depositedUsd: entry.depositedAmountUsd,
      borrowedUsd: entry.borrowedAmountUsd
    }))
  };
}

export async function runLoopStrategist(
  options: SubagentTickOptions,
  runId: string
): Promise<SubagentTickSummary> {
  if (!options.config.loopStrategy.enabled) {
    return { action: 'skipped', reason: 'Loop strategy disabled' };
  }

  // Read the latest snapshots without holding the ledger lock; any slow work
  // (the LLM call) happens before we re-acquire the lock to insert the proposal.
  const snapshot = options.ledgerStore.load();
  const market = latestMarketSnapshot(snapshot);
  const positions = latestPositionSnapshot(snapshot);
  const existingProposalCount = snapshot.strategyProposals.length;
  const walletBalances = await readWalletBalances(options);

  let proposal: LoopStrategyProposal | null = null;
  let decisionMeta: SubagentTickSummary = { decidedBy: 'deterministic' };

  const llmEnabled =
    options.config.loopStrategy.llmStrategistEnabled && options.config.openai.apiKey.length > 0;

  if (llmEnabled) {
    try {
      const decision = await decideLoopProposalWithLlm({
        options,
        runId,
        market,
        positions,
        existingProposalCount,
        walletBalances
      });
      if (!decision.openLoop) {
        proposal = buildLoopProposal({
          config: options.config,
          runId,
          market,
          positions,
          existingProposalCount,
          walletBalances
        });
        if (!proposal) {
          return {
            action: 'no_proposal',
            decidedBy: 'llm',
            reason: decision.rationale ?? 'LLM strategist chose not to open a loop this cycle'
          };
        }
        decisionMeta = {
          decidedBy: 'deterministic_after_llm_decline',
          llmRationale: decision.rationale ?? 'LLM strategist chose not to open a loop this cycle'
        };
      } else {
        proposal = decision.proposal;
        decisionMeta = { decidedBy: 'llm', ...(decision.meta ?? {}) };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn('LLM loop strategist failed; falling back to deterministic builder', {
        error: message
      });
      decisionMeta = { decidedBy: 'deterministic_fallback', llmError: message };
    }
  }

  if (!proposal) {
    proposal = buildLoopProposal({
      config: options.config,
      runId,
      market,
      positions,
      existingProposalCount,
      walletBalances
    });
  }

  if (!proposal) {
    return {
      action: 'no_proposal',
      reason: 'No loop proposal could be built (missing snapshots or not applicable)',
      ...decisionMeta
    };
  }

  const builtProposal = proposal;
  let summary: SubagentTickSummary = {};
  await options.ledgerStore.update((ledger) => {
    const validation = validateLoopProposal(builtProposal, ledger, options.config);
    if (!validation.allowed) {
      builtProposal.status = 'rejected';
      builtProposal.rejectionReason = validation.reason;
    }
    ledger.strategyProposals.unshift(builtProposal);

    summary = {
      action: builtProposal.status === 'rejected' ? 'proposal_rejected' : 'proposal_created',
      proposalId: builtProposal.id,
      proposalType: builtProposal.proposalType,
      status: builtProposal.status,
      collateralProtocol: builtProposal.collateralProtocol,
      supplyTargetProtocol: builtProposal.supplyTargetProtocol,
      collateralUsd: builtProposal.collateralUsd,
      borrowUsd: builtProposal.borrowUsd,
      projectedNetAprBps: builtProposal.projectedNetAprBps,
      ...decisionMeta,
      ...(builtProposal.rejectionReason ? { rejectionReason: builtProposal.rejectionReason } : {})
    };
  });

  return summary;
}

interface LlmLoopDecision {
  openLoop: boolean;
  proposal: LoopStrategyProposal | null;
  rationale?: string;
  meta?: Record<string, unknown>;
}

interface ParsedLoopDecision {
  openLoop: boolean;
  collateralProtocol?: LendingProtocol;
  supplyTargetProtocol?: LendingProtocol;
  collateralUsd?: number;
  borrowUsd?: number;
  rationale?: string;
}

/**
 * Ask the LLM to choose the loop (which protocols, how much collateral/borrow)
 * given live market + position context. The returned proposal is still subject
 * to the deterministic `validateLoopProposal` gate before it can be executed.
 */
async function decideLoopProposalWithLlm(input: {
  options: SubagentTickOptions;
  runId: string;
  market: MarketSnapshot | null;
  positions: PositionSnapshot | null;
  existingProposalCount: number;
  walletBalances: SuiBalancesResponse | null;
}): Promise<LlmLoopDecision> {
  const { options, runId, market, positions, existingProposalCount, walletBalances } = input;
  if (!market || !positions) {
    throw new Error('Market or position snapshot is unavailable for the LLM strategist');
  }

  const { config, clients } = options;
  const collateralAsset = config.loopStrategy.collateralAsset.toUpperCase();
  const borrowAsset = config.loopStrategy.borrowAsset.toUpperCase();

  const idleUsdc = walletBalances?.usdc.formatted;
  const idleSui = walletBalances?.sui.formatted;

  const context = {
    caps: {
      collateralAsset,
      borrowAsset,
      maxCollateralUsd: config.loopStrategy.maxCollateralUsd,
      maxBorrowUsd: config.loopStrategy.maxBorrowUsd,
      minHealthFactor: config.loopStrategy.minHealthFactor,
      minNetAprBps: config.loopStrategy.minNetAprBps,
      maxConcurrentLoops: config.loopStrategy.maxConcurrentLoops
    },
    wallet: { idleUsdc, idleSui },
    marketRates: market.rates.map((rate) => ({
      protocol: rate.protocol,
      asset: rate.asset,
      supplyApr: rate.supplyApr,
      borrowApr: rate.borrowApr,
      priceUsd: rate.priceUsd
    })),
    positions: positions.protocols.map((entry) => ({
      protocol: entry.protocol,
      healthFactor: entry.healthFactor,
      borrowLimitUsd: entry.borrowLimitUsd,
      weightedBorrowsUsd: entry.weightedBorrowsUsd,
      depositedUsd: entry.depositedAmountUsd,
      borrowedUsd: entry.borrowedAmountUsd
    }))
  };

  const instructions = [
    'You are the loop-strategy subagent for an autonomous Sui DeFi treasury.',
    `Decide whether to open ONE leveraged-yield loop using ${collateralAsset} as collateral and borrowing ${borrowAsset}.`,
    'A loop means: supply collateral on one protocol, borrow the borrow-asset on the SAME protocol, then supply the borrowed asset to a DIFFERENT protocol that pays the best supply APR.',
    'Hard constraints you MUST satisfy:',
    `- collateralProtocol and borrowProtocol are the same protocol and MUST have a ${collateralAsset} market.`,
    `- supplyTargetProtocol MUST differ from collateralProtocol and MUST have a ${borrowAsset} market.`,
    '- collateralUsd must be > 0 and should not exceed the idle wallet USDC (an open loop supplies fresh collateral from the wallet).',
    '- Stay within the provided caps (maxCollateralUsd, maxBorrowUsd). The system independently re-enforces caps and the health-factor floor.',
    '- Open a loop when net APR in basis points is greater than or equal to minNetAprBps and all hard constraints can be met. Do not invent a higher APR threshold.',
    'Respond with STRICT JSON only (no prose, no code fences) shaped exactly as:',
    '{"openLoop": boolean, "collateralProtocol": "suilend|navi|scallop", "supplyTargetProtocol": "suilend|navi|scallop", "collateralUsd": number, "borrowUsd": number, "rationale": string}',
    'If no loop is worthwhile right now, return {"openLoop": false, "rationale": "..."}.'
  ].join('\n');

  const userInput: OpenAIInputItem[] = [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: ['Decide the loop to open from this on-chain context:', JSON.stringify(context, null, 2)].join(
            '\n'
          )
        }
      ]
    }
  ];

  const response = await clients.openai.create({ instructions, input: userInput, tools: [] });
  const text = extractLlmText(response);
  if (!text) {
    throw new Error('LLM strategist returned an empty response');
  }

  const decision = parseLlmLoopDecision(text);
  if (!decision.openLoop) {
    return { openLoop: false, proposal: null, rationale: decision.rationale };
  }

  const built = buildLlmLoopProposal({
    config,
    runId,
    market,
    positions,
    existingProposalCount,
    decision,
    walletBalances
  });
  return {
    openLoop: true,
    proposal: built.proposal,
    rationale: decision.rationale,
    meta: { ...(decision.rationale ? { rationale: decision.rationale } : {}), ...built.meta }
  };
}

function buildLlmLoopProposal(input: {
  config: AppConfig;
  runId: string;
  market: MarketSnapshot;
  positions: PositionSnapshot;
  existingProposalCount: number;
  decision: ParsedLoopDecision;
  walletBalances?: SuiBalancesResponse | null;
}): { proposal: LoopStrategyProposal; meta: Record<string, unknown> } {
  const { config, runId, market, positions, existingProposalCount, decision, walletBalances } = input;
  const collateralProtocol = decision.collateralProtocol as LendingProtocol;
  const supplyTargetProtocol = decision.supplyTargetProtocol as LendingProtocol;

  const collateralMarket = market.rates.find(
    (rate) => rate.protocol === collateralProtocol && rate.asset.toUpperCase() === 'USDC'
  );
  const borrowMarket = market.rates.find(
    (rate) => rate.protocol === collateralProtocol && rate.asset.toUpperCase() === 'SUI'
  );
  const targetMarket = market.rates.find(
    (rate) => rate.protocol === supplyTargetProtocol && rate.asset.toUpperCase() === 'SUI'
  );
  if (!collateralMarket) {
    throw new Error(`LLM chose ${collateralProtocol} but it has no USDC market`);
  }
  if (!borrowMarket) {
    throw new Error(`LLM chose ${collateralProtocol} but it has no SUI borrow market`);
  }
  if (!targetMarket) {
    throw new Error(`LLM chose ${supplyTargetProtocol} but it has no SUI supply market`);
  }

  // Clamp to policy caps so a slightly over-cap suggestion still opens within bounds.
  const collateralUsd = Math.min(
    decision.collateralUsd ?? 0,
    maxFreshCollateralUsd(config, walletBalances)
  );
  const suiPrice = borrowMarket.priceUsd > 0 ? borrowMarket.priceUsd : 1;
  const rawBorrowAmount = cappedSuiBorrowRaw(decision.borrowUsd ?? 0, suiPrice, config).toString();
  const borrowUsd = suiRawToUsd(rawBorrowAmount, suiPrice);
  const clamped = collateralUsd !== decision.collateralUsd || borrowUsd !== decision.borrowUsd;

  const rawCollateralAmount = Math.max(1, Math.floor(collateralUsd * 1_000_000)).toString();

  const current = positions.protocols.find((protocol) => protocol.protocol === collateralProtocol);
  const projectedBorrowLimit = (current?.borrowLimitUsd ?? 0) + collateralUsd * 0.7;
  const projectedWeightedBorrow = (current?.weightedBorrowsUsd ?? 0) + borrowUsd;
  const projectedHealthFactor =
    projectedWeightedBorrow > 0 ? projectedBorrowLimit / projectedWeightedBorrow : Number.POSITIVE_INFINITY;
  const projectedNetAprBps = Math.round((targetMarket.supplyApr - borrowMarket.borrowApr) * 100);
  const now = Date.now();

  const proposal: LoopStrategyProposal = {
    id: `proposal-${runId}-${existingProposalCount}`,
    runId,
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
    supplyTargetProtocol,
    rawCollateralAmount,
    rawBorrowAmount,
    collateralUsd,
    borrowUsd,
    projectedHealthFactor,
    projectedNetAprBps,
    netAprBps: projectedNetAprBps,
    targetSupplyAsset: 'SUI',
    rationale:
      decision.rationale ??
      `LLM loop: ${collateralProtocol} USDC collateral, borrow SUI, supply SUI to ${supplyTargetProtocol}.`,
    unwindPath: [
      `withdraw SUI from ${supplyTargetProtocol}`,
      `repay SUI on ${collateralProtocol}`,
      `withdraw USDC from ${collateralProtocol}`
    ],
    marketSnapshotId: market.id,
    positionSnapshotId: positions.id
  };

  return { proposal, meta: { collateralUsd, borrowUsd, ...(clamped ? { clampedToCaps: true } : {}) } };
}

function parseLlmLoopDecision(text: string): ParsedLoopDecision {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('LLM response did not contain a JSON object');
  }

  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  if (parsed.openLoop !== true) {
    return {
      openLoop: false,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined
    };
  }

  const collateralProtocol = toLendingProtocol(parsed.collateralProtocol);
  const supplyTargetProtocol = toLendingProtocol(parsed.supplyTargetProtocol);
  const collateralUsd = Number(parsed.collateralUsd);
  const borrowUsd = Number(parsed.borrowUsd);

  if (!collateralProtocol || !supplyTargetProtocol) {
    throw new Error('LLM decision is missing valid collateral/supply-target protocols');
  }
  if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
    throw new Error('LLM decision has an invalid collateralUsd');
  }
  if (!Number.isFinite(borrowUsd) || borrowUsd <= 0) {
    throw new Error('LLM decision has an invalid borrowUsd');
  }

  return {
    openLoop: true,
    collateralProtocol,
    supplyTargetProtocol,
    collateralUsd,
    borrowUsd,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined
  };
}

function toLendingProtocol(value: unknown): LendingProtocol | null {
  return value === 'suilend' || value === 'navi' || value === 'scallop' ? value : null;
}

function extractLlmText(response: OpenAIResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  const message = (response.output ?? []).find((item) => item.type === 'message');
  const content =
    message && 'content' in message && Array.isArray(message.content) ? message.content : [];
  return content
    .filter((item) => item.type === 'output_text')
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join('\n')
    .trim();
}

export async function runCoordinator(
  options: SubagentTickOptions,
  _runId: string
): Promise<SubagentTickSummary> {
  let summary: SubagentTickSummary = { action: 'no_action', reason: 'No open proposal to evaluate' };
  let archiveRequest: LedgerArchiveRequest | null = null;

  await options.ledgerStore.update((ledger) => {
    const now = Date.now();
    let expiredCount = 0;
    for (const proposal of ledger.strategyProposals) {
      if (proposal.status !== 'open' || new Date(proposal.expiresAt).getTime() <= now) {
        if (proposal.status === 'open') {
          proposal.status = 'expired';
          proposal.rejectionReason = 'Proposal expired';
          expiredCount += 1;
        }
      }
    }

    const stale = staleSubagents(ledger, options.config.loopStrategy.staleHeartbeatMs);
    const staleRoles = stale.map((heartbeat) => heartbeat.role);
    if (stale.length > 0) {
      options.logger.warn('Coordinator observed stale subagent heartbeat', { roles: staleRoles });
    }

    const base: SubagentTickSummary = {
      ...(expiredCount > 0 ? { expiredProposals: expiredCount } : {}),
      ...(staleRoles.length > 0 ? { staleRoles } : {})
    };

    const reconciled = reconcileExpiredExecutingPlans(ledger, options.config, now);
    const didReconcile = reconciled.executed > 0 || reconciled.cancelled > 0;
    if (reconciled.executed > 0 || reconciled.cancelled > 0) {
      summary = {
        ...base,
        action: 'reconciled_expired_execution_claims',
        executed: reconciled.executed,
        cancelled: reconciled.cancelled
      };
    }

    if (activeLoopOpeningPlans(ledger).length > 0) {
      summary = { ...base, action: 'no_action', reason: 'A loop-opening plan is already active' };
      return;
    }

    const proposal = ledger.strategyProposals.find((candidate) => candidate.status === 'open');
    if (!proposal) {
      if (!didReconcile) {
        summary = { ...base, action: 'no_action', reason: 'No open proposal to evaluate' };
      }
      return;
    }

    const policy = {
      ...validateLoopProposal(proposal, ledger, options.config),
      checkedAt: new Date().toISOString()
    };

    if (!policy.allowed) {
      proposal.status = 'rejected';
      proposal.rejectionReason = policy.reason;
      summary = {
        ...base,
        action: 'proposal_rejected',
        proposalId: proposal.id,
        reason: policy.reason
      };
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
    archiveRequest = {
      kind: 'accepted_plan',
      recordId: plan.id,
      value: {
      plan,
      proposal
      }
    };
    summary = {
      ...base,
      action: 'plan_accepted',
      planId: plan.id,
      proposalId: proposal.id
    };
  });

  if (archiveRequest) {
    await archiveLedgerRecordOutsideLock(options, archiveRequest);
  }

  return summary;
}

export async function runExecutor(
  options: SubagentTickOptions,
  runId: string
): Promise<SubagentTickSummary> {
  const result = await claimAndExecuteAcceptedPlan({ ...options, actor: 'executor', runId });
  return { action: result.claimed ? 'executed_plan' : 'no_plan_claimed', ...result };
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
      : ledger.acceptedPlans.find(
          (entry) =>
            entry.status === 'accepted' ||
            (options.config.runtime.dryRun && claimExpired(entry, now))
        );
    if (!candidate) {
      return;
    }
    if (candidate.status !== 'accepted' && !options.config.runtime.dryRun) {
      candidate.failureReason =
        'Live execution claim is already in progress or expired; refusing automatic re-execution to avoid duplicate transactions';
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

  await options.ledgerStore.update((updated) => {
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
  });

  await archiveLedgerRecordOutsideLock(options, {
    kind: 'execution_receipt',
    recordId: receipt.id,
    value: receipt
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

export async function runUnwindGuard(
  options: SubagentTickOptions,
  _runId: string
): Promise<SubagentTickSummary> {
  let summary: SubagentTickSummary = {
    action: 'no_action',
    reason: 'No borrowed position at or below critical health factor'
  };
  let archiveRequest: LedgerArchiveRequest | null = null;

  await options.ledgerStore.update((ledger) => {
    const snapshot = latestPositionSnapshot(ledger);
    if (!snapshot) {
      summary = { action: 'no_action', reason: 'No position snapshot available yet' };
      return;
    }

    const critical = snapshot.protocols.find(
      (positions) =>
        positions.borrows.length > 0 &&
        Number.isFinite(positions.healthFactor) &&
        positions.healthFactor <= options.config.loopStrategy.criticalHealthFactor
    );
    if (!critical) {
      const clearedAt = new Date().toISOString();
      let clearedCount = 0;
      const clearedProtocols = new Set<LendingProtocol>();
      for (const lock of ledger.riskLocks) {
        if (lock.active && lock.severity === 'critical') {
          if (lock.protocol) {
            clearedProtocols.add(lock.protocol);
          }
          lock.active = false;
          lock.clearedAt = clearedAt;
          lock.reason = `Cleared by unwind-guard: latest position snapshot has no borrowed position at or below LOOP_CRITICAL_HEALTH_FACTOR (${options.config.loopStrategy.criticalHealthFactor})`;
          clearedCount += 1;
        }
      }
      let reactivatedLoopCount = 0;
      for (const loop of ledger.loopPositions) {
        if (loop.status === 'unwinding' && clearedProtocols.has(loop.collateralProtocol)) {
          loop.status = 'active';
          delete loop.unwindStatus;
          reactivatedLoopCount += 1;
        }
      }
      if (clearedCount > 0) {
        summary = {
          action: 'risk_locks_cleared',
          clearedCount,
          reactivatedLoopCount,
          reason: 'Latest position snapshot has no borrowed position at or below critical health factor'
        };
      }
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
      summary = {
        action: 'risk_lock_refreshed',
        protocol: critical.protocol,
        healthFactor: critical.healthFactor,
        lockId: existing.id
      };
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
    let unwindingCount = 0;
    for (const loop of ledger.loopPositions) {
      if (loop.status === 'active') {
        loop.status = 'unwinding';
        loop.unwindStatus = lock.reason;
        unwindingCount += 1;
      }
    }
    archiveRequest = { kind: 'risk_lock', recordId: lock.id, value: lock };
    summary = {
      action: 'risk_lock_created',
      protocol: critical.protocol,
      healthFactor: critical.healthFactor,
      lockId: lock.id,
      loopsMarkedUnwinding: unwindingCount
    };
  });

  if (archiveRequest) {
    await archiveLedgerRecordOutsideLock(options, archiveRequest);
  }

  return summary;
}

export function buildLoopProposal(input: {
  config: AppConfig;
  runId: string;
  market: MarketSnapshot | null;
  positions: PositionSnapshot | null;
  existingProposalCount?: number;
  walletBalances?: SuiBalancesResponse | null;
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

  const collateralUsd = maxFreshCollateralUsd(config, input.walletBalances);
  if (collateralUsd <= 0) {
    return null;
  }
  const rawCollateralAmount = Math.max(1, Math.floor(collateralUsd * 1_000_000)).toString();
  const suiPrice = borrowMarket.priceUsd > 0 ? borrowMarket.priceUsd : 1;
  const cappedBorrowRaw = cappedSuiBorrowRaw(config.loopStrategy.maxBorrowUsd, suiPrice, config);
  if (cappedBorrowRaw <= 0n) {
    return null;
  }
  const rawBorrowAmount = cappedBorrowRaw.toString();
  const borrowUsd = suiRawToUsd(rawBorrowAmount, suiPrice);
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

  const projectedNetAprBps = Math.round((target.supplyApr - borrowMarket.borrowApr) * 100);
  const suiPrice = borrowMarket.priceUsd > 0 ? borrowMarket.priceUsd : 1;
  const cappedBorrowRaw = cappedSuiBorrowRaw(plannedBorrowUsd(collateral.protocol, config), suiPrice, config);
  if (cappedBorrowRaw <= 0n) {
    return null;
  }
  const rawBorrowAmount = cappedBorrowRaw.toString();
  const borrowUsd = suiRawToUsd(rawBorrowAmount, suiPrice);
  const projectedWeightedBorrow = collateral.protocol.weightedBorrowsUsd + borrowUsd;
  const borrowLimitUsd = effectiveBorrowLimitUsd(collateral.protocol);
  const projectedHealthFactor =
    projectedWeightedBorrow > 0 ? borrowLimitUsd / projectedWeightedBorrow : Number.POSITIVE_INFINITY;
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
  try {
    if (BigInt(proposal.rawBorrowAmount) > config.sui.maxBorrowRaw) {
      return deny(`Borrow raw amount exceeds SUI_MAX_BORROW_AMOUNT_RAW (${config.sui.maxBorrowRaw})`);
    }
  } catch {
    return deny('Borrow raw amount must be a valid integer');
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
  const activeLoopCount = (ledger.loopPositions ?? []).filter(
    (position) => position.status === 'active' || position.status === 'opening'
  ).length;
  if (activeLoopCount >= config.loopStrategy.maxConcurrentLoops) {
    return deny(
      `Maximum concurrent loop positions reached (${activeLoopCount}/${config.loopStrategy.maxConcurrentLoops})`
    );
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

function reconcileExpiredExecutingPlans(
  ledger: {
    acceptedPlans: AcceptedPlan[];
    strategyProposals: LoopStrategyProposal[];
    positionSnapshots: PositionSnapshot[];
    executionReceipts: Array<{
      id: string;
      planId: string;
      proposalId: string;
      executorRunId: string;
      executedBy?: StrategyExecutionActor;
      dryRun: boolean;
      startedAt: string;
      completedAt: string;
      status: 'planned' | 'confirmed' | 'failed';
      legs: ExecutionLegReceipt[];
      beforeHealthFactor?: number;
      afterHealthFactor?: number;
      walrusReportBlobId?: string;
      error?: string;
    }>;
    loopPositions: Array<{
      id: string;
      planId: string;
      proposalId: string;
      openedAt: string;
      status: 'opening' | 'active' | 'unwinding' | 'closed';
      collateralProtocol: LendingProtocol;
      supplyTargetProtocol: LendingProtocol;
      collateralAsset: 'USDC';
      borrowAsset: 'SUI';
      rawCollateralAmount: string;
      rawBorrowAmount: string;
      borrowUsd: number;
      depth: 1;
      unwindStatus?: string;
    }>;
  },
  config: AppConfig,
  now = Date.now()
): { executed: number; cancelled: number } {
  if (config.runtime.dryRun) {
    return { executed: 0, cancelled: 0 };
  }

  let executed = 0;
  let cancelled = 0;
  const snapshot = latestPositionSnapshot(ledger as never);
  for (const plan of ledger.acceptedPlans) {
    if (!claimExpired(plan, now)) {
      continue;
    }

    const proposal = ledger.strategyProposals.find((entry) => entry.id === plan.proposalId);
    if (!proposal) {
      plan.status = 'cancelled';
      plan.failureReason =
        'Expired live execution claim could not be reconciled because the proposal is missing';
      cancelled += 1;
      continue;
    }

    if (snapshot && executionAppearsOnChain(proposal, snapshot)) {
      const completedAt = new Date(now).toISOString();
      const receipt = {
        id: `receipt-${plan.id}-${now}-reconciled`,
        planId: plan.id,
        proposalId: proposal.id,
        executorRunId: plan.executorRunId ?? 'reconciled-expired-claim',
        executedBy: plan.claimedBy,
        dryRun: false,
        startedAt: plan.claimedAt ?? plan.acceptedAt,
        completedAt,
        status: 'confirmed' as const,
        legs: executionLegs(proposal, false).map((leg) => ({ ...leg, status: 'confirmed' as const }))
      };
      ledger.executionReceipts.unshift(receipt);
      plan.status = 'executed';
      plan.executionReceiptId = receipt.id;
      plan.failureReason = undefined;
      if (!ledger.loopPositions.some((loop) => loop.planId === plan.id)) {
        ledger.loopPositions.unshift({
          id: `loop-${plan.id}`,
          planId: plan.id,
          proposalId: proposal.id,
          openedAt: completedAt,
          status: 'active',
          collateralProtocol: proposal.collateralProtocol,
          supplyTargetProtocol: proposal.supplyTargetProtocol,
          collateralAsset: proposal.collateralAsset,
          borrowAsset: proposal.borrowAsset,
          rawCollateralAmount: proposal.rawCollateralAmount,
          rawBorrowAmount: proposal.rawBorrowAmount,
          borrowUsd: proposal.borrowUsd,
          depth: 1
        });
      }
      executed += 1;
      continue;
    }

    plan.status = 'cancelled';
    plan.failureReason =
      'Expired live execution claim could not be reconciled from the latest position snapshot; refusing automatic re-execution';
    cancelled += 1;
  }

  return { executed, cancelled };
}

function executionAppearsOnChain(proposal: LoopStrategyProposal, snapshot: PositionSnapshot): boolean {
  const collateral = snapshot.protocols.find((entry) => entry.protocol === proposal.collateralProtocol);
  const target = snapshot.protocols.find((entry) => entry.protocol === proposal.supplyTargetProtocol);
  if (!collateral || !target) {
    return false;
  }

  const collateralDepositOk =
    proposal.proposalType === 'borrow_against_existing_collateral' ||
    hasPositionAmount(collateral.deposits, 'USDC', proposal.rawCollateralAmount, proposal.collateralUsd);
  const borrowOk = hasPositionAmount(collateral.borrows, 'SUI', proposal.rawBorrowAmount, proposal.borrowUsd);
  const targetSupplyOk = hasPositionAmount(target.deposits, 'SUI', proposal.rawBorrowAmount, proposal.borrowUsd);
  return collateralDepositOk && borrowOk && targetSupplyOk;
}

function hasPositionAmount(
  legs: Array<{ asset: string; rawAmount: string; amountUsd: number }>,
  asset: 'USDC' | 'SUI',
  rawAmount: string,
  amountUsd: number
): boolean {
  const matching = legs.filter((leg) => leg.asset.toUpperCase() === asset);
  const expectedRaw = safeBigInt(rawAmount);
  if (expectedRaw !== null) {
    const rawTotal = matching.reduce((sum, leg) => {
      const parsed = safeBigInt(leg.rawAmount);
      return parsed === null ? sum : sum + parsed;
    }, 0n);
    if (rawTotal >= expectedRaw) {
      return true;
    }
  }

  const usdTotal = matching.reduce((sum, leg) => sum + leg.amountUsd, 0);
  return usdTotal >= amountUsd * 0.9;
}

function safeBigInt(value: string): bigint | null {
  try {
    if (!/^\d+$/.test(value)) {
      return null;
    }
    return BigInt(value);
  } catch {
    return null;
  }
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

async function readWalletBalances(options: SubagentTickOptions): Promise<SuiBalancesResponse | null> {
  try {
    return await options.clients.suiExecution.getCoinBalances(options.config.agent.walletAddress);
  } catch {
    // Wallet balance reads are a sizing guard for fresh collateral. Existing
    // collateral proposals can still be built from position snapshots.
    return null;
  }
}

function maxFreshCollateralUsd(
  config: AppConfig,
  walletBalances: SuiBalancesResponse | null | undefined
): number {
  const caps = [config.loopStrategy.maxCollateralUsd];
  if (walletBalances) {
    caps.push(rawToUnits(walletBalances.usdc.raw, 6));
  }
  return Math.max(0, Math.min(...caps));
}

function cappedSuiBorrowRaw(maxBorrowUsd: number, suiPriceUsd: number, config: AppConfig): bigint {
  if (maxBorrowUsd <= 0 || suiPriceUsd <= 0 || config.sui.maxBorrowRaw <= 0n) {
    return 0n;
  }

  const requestedRaw = BigInt(Math.max(0, Math.floor((maxBorrowUsd / suiPriceUsd) * 1_000_000_000)));
  return requestedRaw < config.sui.maxBorrowRaw ? requestedRaw : config.sui.maxBorrowRaw;
}

function suiRawToUsd(rawAmount: string | bigint, suiPriceUsd: number): number {
  return rawToUnits(rawAmount, 9) * suiPriceUsd;
}

function rawToUnits(rawAmount: string | bigint, decimals: number): number {
  return Number(rawAmount) / 10 ** decimals;
}

async function archiveLedgerRecordOutsideLock(
  options: SubagentTickOptions,
  request: LedgerArchiveRequest
): Promise<void> {
  try {
    const stored = await options.clients.walrusBlob.storeString(JSON.stringify(request.value, null, 2));
    await options.ledgerStore.update((ledger) => {
      appendWalrusArchive(ledger, request.kind, request.recordId, stored);
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger.warn('Failed to archive strategy ledger record to Walrus', {
      kind: request.kind,
      recordId: request.recordId,
      error: message
    });
  }
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
