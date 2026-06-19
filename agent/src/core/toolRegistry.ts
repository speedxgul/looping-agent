import { normalizeStructTag } from '@mysten/sui/utils';
import {
  type AgentAction,
  type AppConfig,
  type Clients,
  type ExecuteTransactionResult,
  LENDING_ACTION_TYPE,
  type LendingMarket,
  type LendingProtocol,
  type LendingProtocolClient,
  type LendingRateRow,
  type Logger,
  type NormalizedPositions,
  type OpenAIFunctionCallItem,
  type OpenAIToolDefinition,
  type PositionActionKind,
  type SuiBalancesResponse,
  type SuilendMarket
} from '../types.js';
import { formatUnits } from '../utils/amounts.js';
import { explorerTxUrl } from '../utils/suiNetwork.js';
import {
  type AgentPositionActionRecord,
  type AgentStateV1,
  getMemorySummary,
  recordPositionAction,
  recordTweet,
  shouldSkipWriteAction,
  updateSnapshots
} from './agentMemory.js';
import { netSupplyApr, type ReserveCurve, solveAllocation } from './allocation.js';
import type { SaveOptions } from './memoryStore.js';
import { evaluateActionPolicy, evaluateRebalanceBreakeven } from './policy.js';

const PROTOCOLS: LendingProtocol[] = ['suilend', 'navi', 'scallop'];

/** Resolve a protocol name to its client (all implement LendingProtocolClient). */
function protocolClient(clients: Clients, protocol: LendingProtocol): LendingProtocolClient {
  if (protocol === 'navi') return clients.navi;
  if (protocol === 'scallop') return clients.scallop;
  return clients.suilend;
}

function parseProtocolArg(value: unknown): LendingProtocol {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw === 'navi' || raw === 'scallop' ? raw : 'suilend';
}

/** Force the protocol arg without tripping the duplicate-key overwrite check. */
function forceProtocol(args: Record<string, unknown>, protocol: LendingProtocol): Record<string, unknown> {
  return Object.assign({}, args, { protocol });
}

/**
 * Compare two Sui coin types robustly: protocols return them in different forms
 * (NAVI omits 0x, SUI is the short 0x2 vs padded 0x00..02). Normalize both sides.
 */
function sameCoinType(a: string, b: string): boolean {
  return canonicalCoinType(a) === canonicalCoinType(b);
}

function canonicalCoinType(value: string): string {
  const withPrefix = value.includes('::') && !value.startsWith('0x') ? `0x${value}` : value;
  try {
    return normalizeStructTag(withPrefix).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export interface AgentMemoryContext {
  state: AgentStateV1;
  runId: string;
  statePath: string;
  persist: (opts?: SaveOptions) => Promise<void>;
}

interface ToolRegistryOptions {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
  memory: AgentMemoryContext;
}

type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => Promise<Record<string, unknown>>;

export function createToolRegistry({ config, clients, logger, memory }: ToolRegistryOptions) {
  const postActionUpdate = async (args: ToolArgs) => handlePostActionUpdate(args, config, clients, memory);

  const handlers: Record<string, ToolHandler> = {
    get_agent_memory: async () => ({
      ok: true,
      memory: getMemorySummary(memory.state, config, memory.runId)
    }),

    recall_memory: async (args) => {
      const query = readStringArg(args.query, '');
      if (!query.trim()) {
        return { ok: false, error: 'query is required' };
      }

      if (!clients.walrusMemory.enabled) {
        return {
          ok: false,
          enabled: false,
          reason: clients.walrusMemory.reason ?? 'Walrus Memory disabled',
          memories: []
        };
      }

      const limit = Math.min(Math.max(readNumberArg(args.limit, 5), 1), 20);
      const memories = await clients.walrusMemory.recall(query, limit);
      return { ok: true, enabled: true, query, count: memories.length, memories };
    },

    remember_insight: async (args) => {
      const text = readStringArg(args.text, '');
      if (!text.trim()) {
        return { ok: false, error: 'text is required' };
      }

      if (!clients.walrusMemory.enabled) {
        return {
          ok: false,
          enabled: false,
          reason: clients.walrusMemory.reason ?? 'Walrus Memory disabled'
        };
      }

      const jobId = await clients.walrusMemory.remember(text);
      return { ok: jobId !== null, enabled: true, jobId };
    },

    get_sui_balances: async () => {
      if (!config.agent.walletAddress) {
        return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
      }

      if (!config.sui.enabled) {
        return { ok: false, error: 'Sui lending is disabled' };
      }

      const balances = await clients.suiExecution.getCoinBalances(config.agent.walletAddress);
      const usdcRaw = BigInt(balances.usdc.raw);
      const hints = buildSupplyHints(config, usdcRaw, memory.state);

      updateSnapshots(memory.state, { lastUsdcBalanceRaw: balances.usdc.raw });
      await memory.persist({ durable: false });

      return {
        ok: true,
        ...balances,
        usdcCoinType: config.sui.usdcCoinType,
        suiCoinType: config.sui.suiCoinType,
        treasury: hints
      };
    },

    get_suilend_markets: async () => {
      if (!config.sui.enabled) {
        return { ok: false, error: 'Sui lending is disabled' };
      }

      if (!config.sui.protocols.suilend.enabled) {
        return { ok: false, error: 'Suilend is disabled' };
      }

      const result = await clients.suilend.getMarkets();
      const ranked = result.markets.map((market: SuilendMarket, index: number) => ({
        rank: index + 1,
        coinType: market.coinType,
        symbol: market.symbol,
        decimals: market.decimals,
        supplyApr: market.supplyApr,
        borrowApr: market.borrowApr,
        totalApr: market.totalApr,
        price: market.price,
        allowed: market.allowed
      }));

      if (ranked[0]) {
        updateSnapshots(memory.state, { lastTopMarketAsset: ranked[0].symbol });
        await memory.persist({ durable: false });
      }

      return {
        ok: true,
        network: config.sui.network,
        count: ranked.length,
        rateNotes:
          'Markets are Suilend reserves filtered by SUI_ALLOWED_ASSETS and sorted by supply APR (totalApr) descending.',
        topMarket: ranked[0] ?? null,
        markets: ranked
      };
    },

    get_suilend_obligation: async () => {
      if (!config.agent.walletAddress) {
        return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
      }

      if (!config.sui.enabled) {
        return { ok: false, error: 'Sui lending is disabled' };
      }

      const obligation = await clients.suilend.getObligation(config.agent.walletAddress);
      updateSnapshots(memory.state, {
        lastSuilendObligation: obligation,
        lastHealthFactor: obligation.healthFactor
      });
      await memory.persist({ durable: false });

      return {
        ok: true,
        wallet: config.agent.walletAddress,
        ...obligation
      };
    },

    get_lending_rates_comparison: async () => {
      if (!config.sui.enabled) {
        return { ok: false, error: 'Sui lending is disabled' };
      }

      const assets = defaultComparisonAssets(config);
      const [suilendResult, naviRows, scallopRows] = await Promise.all([
        config.sui.protocols.suilend.enabled
          ? clients.suilend.getMarkets()
          : Promise.resolve({ markets: [] }),
        clients.navi.getRates(assets),
        clients.scallop.getRates(assets)
      ]);

      const rows: LendingRateRow[] = assets.map((asset) => {
        const coinType = clients.suilend.resolveCoinType(asset);
        const suilendMarket = suilendResult.markets.find(
          (market: SuilendMarket) => market.coinType.toLowerCase() === coinType.toLowerCase()
        );
        const navi = naviRows.find((row: LendingRateRow) => row.asset.toLowerCase() === asset.toLowerCase());
        const scallop = scallopRows.find(
          (row: LendingRateRow) => row.asset.toLowerCase() === asset.toLowerCase()
        );

        return {
          asset,
          coinType,
          ...(suilendMarket
            ? { suilend: { supplyApr: suilendMarket.supplyApr, borrowApr: suilendMarket.borrowApr } }
            : {}),
          ...(navi?.navi ? { navi: navi.navi } : {}),
          ...(scallop?.scallop ? { scallop: scallop.scallop } : {})
        };
      });

      return {
        ok: true,
        network: config.sui.network,
        assets,
        protocols: {
          suilend: config.sui.protocols.suilend.enabled,
          navi: config.sui.protocols.navi.enabled,
          scallop: config.sui.protocols.scallop.enabled
        },
        rows
      };
    },

    get_best_supply_target: async () => getBestSupplyTarget(config, clients),

    get_optimal_allocation: async () => getOptimalAllocation(config, clients, memory),

    get_rebalance_plan: async () => getRebalancePlan(config, clients),

    get_lending_positions: async (args) => {
      if (!config.sui.enabled) {
        return { ok: false, error: 'Sui lending is disabled' };
      }
      const protocol = parseProtocolArg(args.protocol);
      const positions = await protocolClient(clients, protocol).getPositions(config.agent.walletAddress);
      if (protocol === 'suilend') {
        updateSnapshots(memory.state, {
          lastSuilendObligation: positions,
          lastHealthFactor: positions.healthFactor
        });
        await memory.persist({ durable: false });
      }
      return { ok: true, wallet: config.agent.walletAddress, ...positions };
    },

    lending_supply: async (args) => runLendingWrite({ kind: 'supply', args, config, clients, memory }),
    lending_withdraw: async (args) => runLendingWrite({ kind: 'withdraw', args, config, clients, memory }),
    lending_borrow: async (args) => runLendingWrite({ kind: 'borrow', args, config, clients, memory }),
    lending_repay: async (args) => runLendingWrite({ kind: 'repay', args, config, clients, memory }),

    // Deprecated Suilend-specific aliases (force protocol=suilend) for back-compat.
    suilend_supply: async (args) =>
      runLendingWrite({ kind: 'supply', args: forceProtocol(args, 'suilend'), config, clients, memory }),
    suilend_withdraw: async (args) =>
      runLendingWrite({ kind: 'withdraw', args: forceProtocol(args, 'suilend'), config, clients, memory }),
    suilend_borrow: async (args) =>
      runLendingWrite({ kind: 'borrow', args: forceProtocol(args, 'suilend'), config, clients, memory }),
    suilend_repay: async (args) =>
      runLendingWrite({ kind: 'repay', args: forceProtocol(args, 'suilend'), config, clients, memory }),

    post_action_update: postActionUpdate,

    post_deposit_update: async (args) =>
      postActionUpdate({
        ...args,
        actionId: typeof args.actionId === 'string' ? args.actionId : args.depositId
      }),

    inspect_runtime_policy: async () => {
      const treasuryEnabled =
        !config.runtime.dryRun && config.sui.enabled && config.sui.enablePositionCreation;

      return {
        ok: true,
        policy: {
          dryRun: config.runtime.dryRun,
          suiNetwork: config.sui.network,
          suiRpcUrl: config.sui.rpcUrl ? '(configured)' : '(missing)',
          enableXPosting: config.x.enablePosting,
          enableSuiLending: config.sui.enabled,
          enableSuiPositionCreation: config.sui.enablePositionCreation,
          enableSuiBorrow: config.sui.enableBorrow,
          autoSupplyIntent: treasuryEnabled,
          minIdleRaw: config.sui.minIdleRaw.toString(),
          maxSupplyRaw: config.sui.maxSupplyRaw.toString(),
          maxBorrowRaw: config.sui.maxBorrowRaw.toString(),
          minHealthFactor: config.sui.minHealthFactor,
          actionCooldownMs: config.agent.actionCooldownMs,
          usdcCoinType: config.sui.usdcCoinType,
          suiCoinType: config.sui.suiCoinType,
          allowedAssets: config.sui.allowedAssets,
          allowedPools: config.sui.allowedPools,
          defaultAssets: config.sui.defaultAssets,
          explorerBaseUrl: config.sui.explorerBaseUrl,
          rebalancing: config.sui.rebalancing,
          protocols: config.sui.protocols,
          agentStatePath: memory.statePath
        },
        memory: getMemorySummary(memory.state, config, memory.runId)
      };
    }
  };

  return {
    definitions,
    async execute(toolCall: OpenAIFunctionCallItem): Promise<Record<string, unknown>> {
      const handler = handlers[toolCall.name];
      if (!handler) {
        return { ok: false, error: `Unknown tool: ${toolCall.name}` };
      }

      try {
        const args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
        logger.info('Executing model-requested tool', {
          tool: toolCall.name,
          args: redactToolArgs(toolCall.name, args)
        });
        return await handler(args);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Tool execution failed', {
          tool: toolCall.name,
          error: message
        });
        return { ok: false, error: message };
      }
    }
  };
}

interface LendingWriteOptions {
  kind: PositionActionKind;
  args: ToolArgs;
  config: AppConfig;
  clients: Clients;
  memory: AgentMemoryContext;
}

async function runLendingWrite(options: LendingWriteOptions): Promise<Record<string, unknown>> {
  const { kind, args, config, clients, memory } = options;
  const protocol = parseProtocolArg(args.protocol);
  const client = protocolClient(clients, protocol);

  const asset = resolveAsset(args, config);
  if (!asset) {
    return blocked('asset is required (or use market shorthand usdc/sui)', config);
  }

  const coinType = client.resolveCoinType(asset);
  const rawAmount = readStringArg(args.rawAmount, '0');

  const memorySkip = shouldSkipWriteAction(memory.state, config, asset, kind);
  if (memorySkip.skip) {
    return blocked(memorySkip.reason ?? 'blocked by memory', config);
  }

  let amount: bigint;
  try {
    amount = BigInt(rawAmount);
  } catch {
    return blocked('rawAmount must be a valid integer string', config);
  }
  if (amount <= 0n) {
    return blocked('rawAmount must be greater than zero', config);
  }

  // Positions are needed for any non-supply action (obligation handles) and to
  // simulate the borrow health factor. Supply creates/uses positions internally.
  let positions: NormalizedPositions | undefined;
  if (kind !== 'supply') {
    positions = await client.getPositions(config.agent.walletAddress);
    if (client.requiresObligationForWrite && !positions.obligationId) {
      return blocked(`No ${protocol} position/obligation found for wallet`, config);
    }
  }

  // Balance checks for actions that spend wallet coins.
  const validateBalance = kind === 'supply' || kind === 'repay';
  if (validateBalance && config.agent.walletAddress) {
    const balances = await clients.suiExecution.getCoinBalances(config.agent.walletAddress);
    const balanceRaw = balanceRawForCoinType(balances, coinType, config);

    if (kind === 'supply' && coinType.toLowerCase() === config.sui.usdcCoinType.toLowerCase()) {
      if (balanceRaw < config.sui.minIdleRaw) {
        return blocked(`Wallet USDC balance ${balances.usdc.formatted} is below MIN_IDLE_USDC_RAW`, config);
      }
    }

    if (balanceRaw < amount) {
      return blocked(`rawAmount exceeds wallet balance (${balanceRaw.toString()})`, config);
    }
  }

  const details: Record<string, unknown> = { protocol, asset, coinType, rawAmount };
  if (positions?.obligationId) {
    details.obligationId = positions.obligationId;
  }

  if (kind === 'borrow') {
    const borrowUsd = await estimateBorrowUsd(client, coinType, rawAmount);
    details.projectedHealthFactor = await client.simulateHealthFactorAfterBorrow({
      coinType,
      rawAmount,
      borrowUsd,
      positions: positions ?? (await client.getPositions(config.agent.walletAddress))
    });
    details.projectedBorrowUsd = borrowUsd;
  }

  const action: AgentAction = { type: LENDING_ACTION_TYPE[kind], details };
  const decision = evaluateActionPolicy(action, config);
  if (!decision.allowed) {
    return blocked(decision.reason, config);
  }

  if (config.runtime.dryRun) {
    const record = recordPositionAction(memory.state, {
      runId: memory.runId,
      protocol,
      action: kind,
      asset,
      rawAmount,
      ...(positions?.obligationId ? { obligationId: positions.obligationId } : {}),
      status: 'planned',
      dryRun: true
    });
    await memory.persist({ durable: false });

    return {
      ok: true,
      dryRun: true,
      plannedAction: {
        protocol,
        action: kind,
        asset,
        coinType,
        rawAmount,
        ...(details.projectedHealthFactor !== undefined
          ? { projectedHealthFactor: details.projectedHealthFactor }
          : {})
      },
      recordedActionId: record.id
    };
  }

  await clients.suiExecution.assertWalletMatches();

  const params = { coinType, asset, rawAmount, positions };
  let result: ExecuteTransactionResult;
  switch (kind) {
    case 'supply':
      result = await client.executeSupply(params);
      break;
    case 'withdraw':
      result = await client.executeWithdraw(params);
      break;
    case 'borrow':
      result = await client.executeBorrow(params);
      break;
    case 'repay':
      result = await client.executeRepay(params);
      break;
  }

  const record = recordPositionAction(
    memory.state,
    {
      runId: memory.runId,
      protocol,
      action: kind,
      asset,
      rawAmount,
      ...(positions?.obligationId ? { obligationId: positions.obligationId } : {}),
      status: 'confirmed',
      digest: result.digest,
      dryRun: false
    },
    { enablePosting: config.x.enablePosting && Boolean(config.x.userAccessToken) }
  );
  await memory.persist({ durable: true });

  return {
    ok: true,
    dryRun: false,
    protocol,
    recordedActionId: record.id,
    pendingTweet: kind === 'supply' && memory.state.pending.some((task) => task.actionId === record.id),
    digest: result.digest,
    result
  };
}

function blocked(reason: string, config: AppConfig): Record<string, unknown> {
  return { ok: false, blocked: true, reason, dryRun: config.runtime.dryRun };
}

/**
 * Deterministic yield-router helper: rank net supply APR across write-enabled
 * protocols for allowlisted assets and return the best target plus the runner-up
 * delta (so the model/policy can apply rebalance hysteresis).
 */
async function getBestSupplyTarget(config: AppConfig, clients: Clients): Promise<Record<string, unknown>> {
  if (!config.sui.enabled) {
    return { ok: false, error: 'Sui lending is disabled' };
  }

  const assets = defaultComparisonAssets(config);
  const candidates: Array<{ protocol: LendingProtocol; asset: string; coinType: string; supplyApr: number }> =
    [];

  for (const protocol of PROTOCOLS) {
    if (!config.sui.protocols[protocol]?.write || !config.sui.allowedProtocols.includes(protocol)) {
      continue;
    }
    const client = protocolClient(clients, protocol);
    let markets: LendingMarket[] = [];
    try {
      markets = (await client.getMarkets()).markets;
    } catch {
      continue;
    }
    for (const asset of assets) {
      const coinType = client.resolveCoinType(asset);
      const market = markets.find((m) => sameCoinType(m.coinType, coinType));
      if (market) {
        candidates.push({ protocol, asset, coinType, supplyApr: market.supplyApr });
      }
    }
  }

  candidates.sort((a, b) => b.supplyApr - a.supplyApr);
  const best = candidates[0] ?? null;
  const runnerUp =
    candidates.find((c) => best && (c.protocol !== best.protocol || c.asset !== best.asset)) ?? null;
  const deltaBps = best && runnerUp ? Math.round((best.supplyApr - runnerUp.supplyApr) * 100) : null;

  return {
    ok: true,
    network: config.sui.network,
    best,
    runnerUp,
    deltaBps,
    rebalanceMinAprDeltaBps: config.sui.rebalanceMinAprDeltaBps,
    candidates
  };
}

/**
 * Own-impact-aware yield router. Instead of dumping the whole budget into today's
 * top spot APR (which is provably suboptimal because depositing lowers that pool's
 * rate), this gathers each write-enabled protocol's full reserve curve and runs the
 * water-filling solver to split idle USDC so the marginal net yield is equalized.
 * Returns the per-leg allocation the model should execute via `lending_supply`.
 */
async function getOptimalAllocation(
  config: AppConfig,
  clients: Clients,
  memory: AgentMemoryContext
): Promise<Record<string, unknown>> {
  if (!config.sui.enabled) {
    return { ok: false, error: 'Sui lending is disabled' };
  }
  if (!config.agent.walletAddress) {
    return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
  }

  // Budget = idle USDC, capped by the treasury supply hints (min idle / max supply).
  const balances = await clients.suiExecution.getCoinBalances(config.agent.walletAddress);
  const usdcRaw = BigInt(balances.usdc.raw);
  const hints = buildSupplyHints(config, usdcRaw, memory.state);
  const budgetRaw = BigInt(hints.supplyableRaw);

  // Gather the USDC reserve curve from each write-enabled, allowlisted protocol.
  const usdcAsset = config.sui.defaultAssets.usdc;
  const curves: ReserveCurve[] = [];
  const skipped: Array<{ protocol: LendingProtocol; reason: string }> = [];

  for (const protocol of PROTOCOLS) {
    if (!config.sui.protocols[protocol]?.write || !config.sui.allowedProtocols.includes(protocol)) {
      skipped.push({ protocol, reason: 'not write-enabled or not allowlisted' });
      continue;
    }
    const client = protocolClient(clients, protocol);
    const coinType = client.resolveCoinType(usdcAsset);
    let market: LendingMarket | undefined;
    try {
      market = (await client.getMarkets()).markets.find((m) => sameCoinType(m.coinType, coinType));
    } catch {
      skipped.push({ protocol, reason: 'getMarkets failed' });
      continue;
    }
    if (!market) {
      skipped.push({ protocol, reason: 'no USDC market' });
      continue;
    }
    if (!market.curve) {
      skipped.push({ protocol, reason: 'no reserve curve available' });
      continue;
    }
    curves.push(market.curve);
  }

  if (curves.length === 0) {
    return {
      ok: true,
      asset: usdcAsset,
      budgetRaw: budgetRaw.toString(),
      canSupply: hints.canSupply,
      allocations: [],
      reason: hints.reason ?? 'No eligible reserve curves to allocate across',
      skipped
    };
  }

  const allocation = solveAllocation({
    curves,
    budgetRaw,
    perProtocolCapRaw: config.sui.maxSupplyRaw,
    minPositionRaw: config.sui.minIdleRaw > 0n ? config.sui.minIdleRaw : undefined
  });

  // Enrich each leg with what `lending_supply` needs plus a spot-vs-optimized view.
  const legs = allocation.allocations.map((leg) => {
    const curve = curves.find((c) => c.protocol === leg.protocol);
    return {
      protocol: leg.protocol,
      asset: leg.asset,
      coinType: leg.coinType,
      rawAmount: leg.xRaw,
      ...(curve ? { amountFormatted: formatUnits(leg.xRaw, curve.decimals), decimals: curve.decimals } : {}),
      netSupplyApr: leg.netSupplyApr,
      spotNetApr: curve ? round4(netSupplyApr(curve, 0n)) : undefined,
      share: round4(leg.share)
    };
  });

  // Naive baseline (the old heuristic) for the rationale: dump everything into the
  // pool with the best current spot rate, then read its post-deposit net APR.
  const spotRanked = [...curves].sort((a, b) => netSupplyApr(b, 0n) - netSupplyApr(a, 0n));
  const naiveCurve = spotRanked[0];
  const naive = naiveCurve
    ? {
        protocol: naiveCurve.protocol,
        spotNetApr: round4(netSupplyApr(naiveCurve, 0n)),
        netAprIfAllHere: round4(netSupplyApr(naiveCurve, budgetRaw))
      }
    : null;

  const improvementBps =
    naive && budgetRaw > 0n ? Math.round((allocation.blendedNetApr - naive.netAprIfAllHere) * 100) : 0;

  return {
    ok: true,
    asset: usdcAsset,
    budgetRaw: budgetRaw.toString(),
    canSupply: hints.canSupply,
    allocations: legs,
    blendedNetApr: allocation.blendedNetApr,
    marginalApr: allocation.marginalApr,
    allocatedRaw: allocation.allocatedRaw,
    unallocatedRaw: allocation.unallocatedRaw,
    naive,
    improvementBpsVsNaive: improvementBps,
    rebalanceMinAprDeltaBps: config.sui.rebalanceMinAprDeltaBps,
    rationale:
      'Allocation equalizes marginal net supply APR across pools (water-filling). Supply each leg ' +
      'with lending_supply using its protocol + rawAmount. blendedNetApr is the budget-weighted yield; ' +
      'marginalApr is the equalized marginal rate. Skipped protocols lacked write access, an allowlist ' +
      'entry, a USDC market, or a parseable reserve curve.',
    skipped: skipped.length > 0 ? skipped : undefined
  };
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

interface RebalanceSide {
  protocol: LendingProtocol;
  asset: string;
  coinType: string;
  currentRaw: bigint;
  targetRaw: bigint;
  deltaRaw: bigint;
  netApr: number;
  price: number;
  decimals: number;
}

async function getRebalancePlan(config: AppConfig, clients: Clients): Promise<Record<string, unknown>> {
  if (!config.sui.enabled) {
    return { ok: false, error: 'Sui lending is disabled' };
  }
  if (!config.agent.walletAddress) {
    return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
  }
  if (!config.sui.rebalancing.enabled) {
    return {
      ok: true,
      enabled: false,
      planOnly: config.sui.rebalancing.planOnly,
      reason: 'ENABLE_REBALANCING is false',
      moves: []
    };
  }

  const usdcAsset = config.sui.defaultAssets.usdc;
  const curves: ReserveCurve[] = [];
  const currentByProtocol = new Map<LendingProtocol, bigint>();
  const skipped: Array<{ protocol: LendingProtocol; reason: string }> = [];

  for (const protocol of PROTOCOLS) {
    if (!config.sui.protocols[protocol]?.write || !config.sui.allowedProtocols.includes(protocol)) {
      skipped.push({ protocol, reason: 'not write-enabled or not allowlisted' });
      continue;
    }

    const client = protocolClient(clients, protocol);
    const coinType = client.resolveCoinType(usdcAsset);
    try {
      const [markets, positions] = await Promise.all([
        client.getMarkets(),
        client.getPositions(config.agent.walletAddress)
      ]);
      const market = markets.markets.find((m) => sameCoinType(m.coinType, coinType));
      if (!market?.curve) {
        skipped.push({ protocol, reason: 'no USDC reserve curve available' });
        continue;
      }
      curves.push(market.curve);

      const suppliedRaw = positions.deposits
        .filter((deposit) => sameCoinType(deposit.coinType, coinType))
        .reduce((sum, deposit) => sum + safeBigInt(deposit.amount), 0n);
      currentByProtocol.set(protocol, suppliedRaw);
    } catch (error: unknown) {
      skipped.push({
        protocol,
        reason: `read failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  if (curves.length === 0) {
    return {
      ok: true,
      enabled: true,
      planOnly: config.sui.rebalancing.planOnly,
      moves: [],
      reason: 'No eligible USDC curves to rebalance across',
      skipped
    };
  }

  const balances = await clients.suiExecution.getCoinBalances(config.agent.walletAddress);
  const idleSupplyableRaw = buildSupplyHints(config, BigInt(balances.usdc.raw), {
    // Rebalance planning is read-only; ignore memory cooldown so the plan reflects
    // economic target state, not whether a write is currently blocked.
    version: 1,
    agentName: config.agent.name,
    walletAddress: config.agent.walletAddress.toLowerCase(),
    updatedAt: new Date().toISOString(),
    runs: [],
    actions: { positionActions: [], tweets: [] },
    snapshots: {},
    pending: [],
    artifacts: []
  }).supplyableRaw;

  const currentTotalRaw = [...currentByProtocol.values()].reduce((sum, raw) => sum + raw, 0n);
  const targetBudgetRaw = currentTotalRaw + BigInt(idleSupplyableRaw);
  if (targetBudgetRaw <= 0n) {
    return {
      ok: true,
      enabled: true,
      planOnly: config.sui.rebalancing.planOnly,
      currentTotalRaw: '0',
      targetBudgetRaw: '0',
      moves: [],
      reason: 'No supplied or deployable idle USDC to rebalance',
      skipped: skipped.length > 0 ? skipped : undefined
    };
  }

  const target = solveAllocation({ curves, budgetRaw: targetBudgetRaw });
  const targetByProtocol = new Map<LendingProtocol, bigint>(
    target.allocations.map((leg) => [leg.protocol, BigInt(leg.xRaw)])
  );
  const sides = curves.map((curve) => {
    const currentRaw = currentByProtocol.get(curve.protocol) ?? 0n;
    const targetRaw = targetByProtocol.get(curve.protocol) ?? 0n;
    return {
      protocol: curve.protocol,
      asset: curve.asset,
      coinType: curve.coinType,
      currentRaw,
      targetRaw,
      deltaRaw: targetRaw - currentRaw,
      netApr: netSupplyApr(curve, 0n),
      price: curve.price,
      decimals: curve.decimals
    };
  });

  const withdrawals: RebalanceSide[] = sides
    .filter((side) => side.deltaRaw < 0n)
    .map((side) => ({ ...side, deltaRaw: -side.deltaRaw }))
    .sort((a, b) => a.netApr - b.netApr);
  const supplies: RebalanceSide[] = sides
    .filter((side) => side.deltaRaw > 0n)
    .sort((a, b) => b.netApr - a.netApr);

  const moves: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];
  const minMoveRaw = config.sui.minIdleRaw > 0n ? config.sui.minIdleRaw : 0n;

  for (const withdraw of withdrawals) {
    let remainingWithdraw = withdraw.deltaRaw;
    for (const supply of supplies) {
      if (remainingWithdraw <= 0n || supply.deltaRaw <= 0n) {
        continue;
      }
      let rawAmount = minBigInt(remainingWithdraw, supply.deltaRaw);
      if (config.sui.maxSupplyRaw > 0n) {
        rawAmount = minBigInt(rawAmount, config.sui.maxSupplyRaw);
      }
      if (rawAmount <= 0n) {
        continue;
      }

      const amountUsd = rawToUsd(rawAmount, withdraw.decimals, withdraw.price);
      const decision = evaluateRebalanceBreakeven(
        {
          currentNetApr: withdraw.netApr,
          targetNetApr: supply.netApr,
          amountUsd,
          horizonDays: config.sui.rebalancing.horizonDays,
          costUsd: config.sui.rebalancing.estimatedCostUsd
        },
        config
      );

      const candidate = {
        fromProtocol: withdraw.protocol,
        toProtocol: supply.protocol,
        asset: usdcAsset,
        coinType: withdraw.coinType,
        rawAmount: rawAmount.toString(),
        amountFormatted: formatUnits(rawAmount.toString(), withdraw.decimals),
        amountUsd,
        currentNetApr: round4(withdraw.netApr),
        targetNetApr: round4(supply.netApr),
        deltaBps: decision.deltaBps,
        expectedGainUsd: decision.expectedGainUsd,
        costUsd: decision.costUsd,
        reason: decision.reason
      };

      if (rawAmount < minMoveRaw) {
        rejected.push({ ...candidate, reason: 'Move is below MIN_IDLE_USDC_RAW dust threshold' });
      } else if (!decision.act) {
        rejected.push(candidate);
      } else {
        moves.push({
          ...candidate,
          planOnly: config.sui.rebalancing.planOnly,
          withdraw: {
            protocol: withdraw.protocol,
            asset: usdcAsset,
            coinType: withdraw.coinType,
            rawAmount: rawAmount.toString()
          },
          supply: {
            protocol: supply.protocol,
            asset: usdcAsset,
            coinType: supply.coinType,
            rawAmount: rawAmount.toString()
          }
        });
        remainingWithdraw -= rawAmount;
        supply.deltaRaw -= rawAmount;
      }
    }
  }

  return {
    ok: true,
    enabled: true,
    planOnly: config.sui.rebalancing.planOnly,
    executionAllowed: false,
    asset: usdcAsset,
    currentTotalRaw: currentTotalRaw.toString(),
    idleSupplyableRaw,
    targetBudgetRaw: targetBudgetRaw.toString(),
    targetAllocation: target.allocations,
    currentAllocation: sides.map((side) => ({
      protocol: side.protocol,
      rawAmount: side.currentRaw.toString(),
      amountFormatted: formatUnits(side.currentRaw.toString(), side.decimals),
      netApr: round4(side.netApr)
    })),
    moves,
    rejected: rejected.length > 0 ? rejected : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
    reason:
      moves.length > 0
        ? 'Plan-only rebalance candidates clear APR and breakeven gates; no transactions were executed.'
        : 'No rebalance move clears APR, cost, and dust gates.'
  };
}

async function handlePostActionUpdate(
  args: ToolArgs,
  config: AppConfig,
  clients: Clients,
  memory: AgentMemoryContext
): Promise<Record<string, unknown>> {
  const actionId =
    typeof args.actionId === 'string'
      ? args.actionId
      : typeof args.depositId === 'string'
        ? args.depositId
        : undefined;
  const pending = memory.state.pending.find((task) => task.type === 'tweet_action');

  if (!actionId && !pending) {
    return { ok: false, error: 'No pending tweet_action task and no actionId provided' };
  }

  const targetActionId = actionId ?? pending?.actionId;
  const action = memory.state.actions.positionActions.find((entry) => entry.id === targetActionId);
  if (!action) {
    return { ok: false, error: `Position action not found: ${targetActionId}` };
  }

  if (action.status !== 'confirmed' || action.dryRun) {
    return {
      ok: false,
      blocked: true,
      reason: 'Only confirmed live position actions can be posted to X',
      actionId: action.id
    };
  }

  if (action.action !== 'supply') {
    return {
      ok: false,
      blocked: true,
      reason: 'Only confirmed supply actions can be posted via post_action_update',
      actionId: action.id
    };
  }

  if (action.tweeted) {
    return { ok: true, alreadyPosted: true, actionId: action.id, tweetId: action.tweetId ?? null };
  }

  if (!config.x.enablePosting) {
    return { ok: false, blocked: true, reason: 'ENABLE_X_POSTING is false', actionId: action.id };
  }

  if (!config.x.userAccessToken) {
    return { ok: false, blocked: true, reason: 'X_USER_ACCESS_TOKEN is missing', actionId: action.id };
  }

  const text =
    typeof args.text === 'string' && args.text.trim()
      ? args.text.trim()
      : await buildDefaultActionPostText(action, config, clients);

  try {
    const post = await clients.x.createPost(text);
    const tweet = recordTweet(memory.state, {
      actionId: action.id,
      status: 'posted',
      externalId: post.id,
      text
    });
    await memory.persist({ durable: true });

    return { ok: true, actionId: action.id, tweetId: post.id, text, recordId: tweet.id };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const tweet = recordTweet(memory.state, { actionId: action.id, status: 'failed', text });
    await memory.persist({ durable: false });

    return {
      ok: false,
      blocked: true,
      reason: message,
      actionId: action.id,
      failedTweetRecordId: tweet.id,
      text
    };
  }
}

function buildSupplyHints(config: AppConfig, usdcRaw: bigint, state: AgentStateV1) {
  const skip = shouldSkipWriteAction(state, config, config.sui.defaultAssets.usdc, 'supply');
  const meetsMin = usdcRaw >= config.sui.minIdleRaw;
  const canSupply = !skip.skip && meetsMin;
  const supplyableRaw = canSupply
    ? usdcRaw < config.sui.maxSupplyRaw
      ? usdcRaw
      : config.sui.maxSupplyRaw
    : 0n;

  return {
    minIdleRaw: config.sui.minIdleRaw.toString(),
    maxSupplyRaw: config.sui.maxSupplyRaw.toString(),
    usdcBalanceRaw: usdcRaw.toString(),
    canSupply,
    supplyableRaw: supplyableRaw.toString(),
    suggestedAsset: config.sui.defaultAssets.usdc,
    suggestedCoinType: config.sui.usdcCoinType,
    supplySkipReason: skip.reason,
    reason: !canSupply ? (skip.reason ?? (meetsMin ? null : 'USDC balance below MIN_IDLE_USDC_RAW')) : null
  };
}

async function buildDefaultActionPostText(
  action: AgentPositionActionRecord,
  config: AppConfig,
  clients: Clients
): Promise<string> {
  const market = await findActionMarket(action, clients);
  const symbol = inferActionSymbol(action, market);
  const decimals = market?.decimals ?? inferAssetDecimals(action.asset, config);
  const amount = formatUnits(action.rawAmount, decimals);
  const protocolLabel = capitalize(action.protocol);
  const parts = [
    `Treasury update: supplied ${amount} ${symbol} into ${protocolLabel} ${market?.symbol ?? 'market'} on Sui.`
  ];

  if (market?.totalApr !== undefined) {
    parts.push(`Current market APR: ~${formatApr(market.totalApr)}%.`);
  }

  if (action.digest) {
    parts.push(`Tx: ${explorerTxUrl(config.sui.explorerBaseUrl, action.digest)}`);
  }

  return parts.join(' ');
}

async function findActionMarket(
  action: AgentPositionActionRecord,
  clients: Clients
): Promise<LendingMarket | null> {
  try {
    const client = protocolClient(clients, action.protocol);
    const coinType = client.resolveCoinType(action.asset);
    const result = await client.getMarkets();
    return result.markets.find((market: LendingMarket) => sameCoinType(market.coinType, coinType)) ?? null;
  } catch {
    return null;
  }
}

function capitalize(value: string): string {
  return value.length ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function inferActionSymbol(action: AgentPositionActionRecord, market: LendingMarket | null): string {
  if (action.asset.length <= 8 && !action.asset.includes('::')) {
    return action.asset.toUpperCase();
  }

  return market?.symbol ?? action.asset;
}

function inferAssetDecimals(asset: string, config: AppConfig): number {
  const key = asset.toLowerCase();
  if (key === 'usdc' || asset.toLowerCase() === config.sui.usdcCoinType.toLowerCase()) {
    return 6;
  }

  if (key === 'sui' || asset.toLowerCase() === config.sui.suiCoinType.toLowerCase()) {
    return 9;
  }

  return 9;
}

function formatApr(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function rawToUsd(rawAmount: bigint, decimals: number, price: number): number {
  return (Number(rawAmount) / 10 ** decimals) * price;
}

function defaultComparisonAssets(config: AppConfig): string[] {
  const candidates = [config.sui.defaultAssets.usdc, config.sui.defaultAssets.sui];
  const unique = [...new Set(candidates.map((asset) => asset.toLowerCase()))];

  if (config.sui.allowedAssets.length === 0) {
    return unique;
  }

  return unique.filter((asset) => config.sui.allowedAssets.some((entry) => entry.toLowerCase() === asset));
}

async function estimateBorrowUsd(
  client: LendingProtocolClient,
  coinType: string,
  rawAmount: string
): Promise<number> {
  const result = await client.getMarkets();
  const market = result.markets.find((entry: LendingMarket) => sameCoinType(entry.coinType, coinType));
  if (!market) {
    return 0;
  }

  const amount = Number(rawAmount) / 10 ** market.decimals;
  return amount * market.price;
}

function balanceRawForCoinType(balances: SuiBalancesResponse, coinType: string, config: AppConfig): bigint {
  if (coinType.toLowerCase() === config.sui.usdcCoinType.toLowerCase()) {
    return BigInt(balances.usdc.raw);
  }

  if (coinType.toLowerCase() === config.sui.suiCoinType.toLowerCase()) {
    return BigInt(balances.sui.raw);
  }

  return 0n;
}

function resolveAsset(args: ToolArgs, config: AppConfig): string {
  if (typeof args.asset === 'string' && args.asset.trim()) {
    return args.asset.trim();
  }

  if (typeof args.coinType === 'string' && args.coinType.trim()) {
    return args.coinType.trim();
  }

  if (args.market === 'usdc') {
    return config.sui.defaultAssets.usdc;
  }

  if (args.market === 'sui') {
    return config.sui.defaultAssets.sui;
  }

  return '';
}

function definitions(): OpenAIToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'inspect_runtime_policy',
      description: 'Inspect local runtime safety policy, Sui treasury thresholds, and agent memory summary.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_agent_memory',
      description:
        'Read persistent agent memory: prior runs, position actions, pending tasks (e.g. tweet after supply), snapshots, and recent Walrus artifact reports.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'recall_memory',
      description:
        'Semantic recall from Walrus Memory (MemWal): search durable cross-session memories (past decisions, market observations, blockers) by natural-language query. Returns the most relevant memories with similarity distance (lower = closer).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            description: 'Max memories to return (default 5).'
          }
        },
        required: ['query']
      }
    },
    {
      type: 'function',
      name: 'remember_insight',
      description:
        'Store a durable insight in Walrus Memory (MemWal) for future runs, e.g. a noteworthy market observation, a decision rationale, or a recurring blocker. Keep it concise and factual.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'The insight to remember.' }
        },
        required: ['text']
      }
    },
    {
      type: 'function',
      name: 'get_sui_balances',
      description:
        'Read Sui wallet SUI and USDC balances with treasury supply hints (min idle, max supply, canSupply, suggested asset).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_suilend_markets',
      description:
        'List Suilend lending markets on Sui with live supply/borrow APRs. Markets are ranked by supply APR. Use before suilend_supply.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_suilend_obligation',
      description:
        'Read Suilend obligation positions, health factor, and borrow limits for the configured wallet.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_lending_rates_comparison',
      description:
        'Compare supply/borrow APRs across Suilend, NAVI, and Scallop for default allowlisted assets (USDC, SUI).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_best_supply_target',
      description:
        'Rank net supply APR across write-enabled protocols (Suilend, NAVI, Scallop) for allowlisted assets. Returns the best protocol+asset to supply, the runner-up, and the APR delta (bps) for rebalance decisions. Simple highest-APR heuristic; prefer get_optimal_allocation.',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
    },
    {
      type: 'function',
      name: 'get_optimal_allocation',
      description:
        "Compute the optimal split of idle USDC across write-enabled protocols using each pool's full reserve rate curve (own-impact aware, water-filling). Returns an allocation vector (protocol + rawAmount per leg), blended and marginal net APR, and the improvement vs the naive highest-APR heuristic. PREFERRED over get_best_supply_target: supply each returned leg via lending_supply.",
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
    },
    {
      type: 'function',
      name: 'get_rebalance_plan',
      description:
        'Plan-only USDC rebalance analysis across write-enabled Suilend, NAVI, and Scallop positions. Returns proposed withdraw+supply moves only when APR hysteresis and cost breakeven gates clear; it never executes transactions.',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
    },
    {
      type: 'function',
      name: 'get_lending_positions',
      description:
        'Read normalized positions (deposits, borrows, health factor, borrow limit) for a given protocol on the configured wallet.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocol: { type: 'string', enum: ['suilend', 'navi', 'scallop'] }
        },
        required: ['protocol']
      }
    },
    {
      type: 'function',
      name: 'lending_supply',
      description:
        'Supply (lend) an asset into a lending protocol to earn yield. Blocked while tweet_action is pending or within action cooldown. Respects policy, dry-run, SUI_ALLOWED_PROTOCOLS, and SUI_ALLOWED_ASSETS.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocol: { type: 'string', enum: ['suilend', 'navi', 'scallop'], description: 'Target protocol.' },
          market: {
            type: 'string',
            enum: ['usdc', 'sui'],
            description: 'Optional shorthand for a default asset.'
          },
          asset: { type: 'string', description: 'Asset shorthand (usdc, sui) or full coin type.' },
          coinType: { type: 'string', description: 'Full Sui coin type. Alternative to asset.' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to supply.' }
        },
        required: ['protocol', 'rawAmount']
      }
    },
    {
      type: 'function',
      name: 'lending_withdraw',
      description: 'Withdraw a supplied asset from a lending protocol.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocol: { type: 'string', enum: ['suilend', 'navi', 'scallop'] },
          market: { type: 'string', enum: ['usdc', 'sui'] },
          asset: { type: 'string' },
          coinType: { type: 'string' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to withdraw.' }
        },
        required: ['protocol', 'rawAmount', 'asset']
      }
    },
    {
      type: 'function',
      name: 'lending_borrow',
      description:
        'Borrow an asset from a lending protocol against existing collateral. Simulates projected health factor and blocks if below SUI_MIN_HEALTH_FACTOR.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocol: { type: 'string', enum: ['suilend', 'navi', 'scallop'] },
          market: { type: 'string', enum: ['usdc', 'sui'] },
          asset: { type: 'string' },
          coinType: { type: 'string' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to borrow.' }
        },
        required: ['protocol', 'rawAmount', 'asset']
      }
    },
    {
      type: 'function',
      name: 'lending_repay',
      description: 'Repay borrowed debt on a lending protocol.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocol: { type: 'string', enum: ['suilend', 'navi', 'scallop'] },
          market: { type: 'string', enum: ['usdc', 'sui'] },
          asset: { type: 'string' },
          coinType: { type: 'string' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to repay.' }
        },
        required: ['protocol', 'rawAmount', 'asset']
      }
    },
    {
      type: 'function',
      name: 'post_action_update',
      description:
        'Post a status update about a confirmed recorded supply action to X. Use when memory shows pending tweet_action.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          actionId: {
            type: 'string',
            description: 'Position action id from agent memory or suilend_supply result.'
          },
          text: { type: 'string', description: 'Optional draft post text.' }
        },
        required: []
      }
    },
    {
      type: 'function',
      name: 'post_deposit_update',
      description: 'Deprecated alias for post_action_update (backward compatibility).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          depositId: { type: 'string', description: 'Legacy alias for actionId.' },
          actionId: { type: 'string' },
          text: { type: 'string' }
        },
        required: []
      }
    }
  ];
}

const WRITE_TOOLS = new Set([
  'lending_supply',
  'lending_withdraw',
  'lending_borrow',
  'lending_repay',
  'suilend_supply',
  'suilend_withdraw',
  'suilend_borrow',
  'suilend_repay'
]);

function redactToolArgs(toolName: string, args: ToolArgs): Record<string, unknown> {
  if (WRITE_TOOLS.has(toolName)) {
    return {
      protocol: args.protocol,
      market: args.market,
      asset: args.asset,
      coinType: args.coinType,
      rawAmount: args.rawAmount
    };
  }

  return args;
}

function readStringArg(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
