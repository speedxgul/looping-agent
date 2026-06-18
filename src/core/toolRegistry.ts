import {
  getMemorySummary,
  recordPositionAction,
  recordTweet,
  shouldSkipWriteAction,
  updateSnapshots,
  type AgentPositionActionRecord,
  type AgentStateV1
} from './agentMemory.js';
import { evaluateActionPolicy } from './policy.js';
import type { SaveOptions } from './memoryStore.js';
import { formatUnits } from '../utils/amounts.js';
import { explorerTxUrl } from '../utils/suiNetwork.js';
import type {
  AgentAction,
  AppConfig,
  Clients,
  LendingRateRow,
  Logger,
  NetworkName,
  OpenAIFunctionCallItem,
  OpenAIToolDefinition,
  PositionActionKind,
  SuilendMarket,
  SuilendObligationResponse,
  SuiBalancesResponse,
  SwapRoute
} from '../types.js';

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
        config.sui.protocols.suilend.enabled ? clients.suilend.getMarkets() : Promise.resolve({ markets: [] }),
        clients.navi.getRates(assets),
        clients.scallop.getRates(assets)
      ]);

      const rows: LendingRateRow[] = assets.map((asset) => {
        const coinType = clients.suilend.resolveCoinType(asset);
        const suilendMarket = suilendResult.markets.find(
          (market: SuilendMarket) => market.coinType.toLowerCase() === coinType.toLowerCase()
        );
        const navi = naviRows.find((row: LendingRateRow) => row.asset.toLowerCase() === asset.toLowerCase());
        const scallop = scallopRows.find((row: LendingRateRow) => row.asset.toLowerCase() === asset.toLowerCase());

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

    suilend_supply: async (args) =>
      runSuilendWrite({
        kind: 'supply',
        actionType: 'SUILEND_SUPPLY',
        args,
        config,
        clients,
        memory,
        requireObligation: false,
        validateBalance: true
      }),

    suilend_withdraw: async (args) =>
      runSuilendWrite({
        kind: 'withdraw',
        actionType: 'SUILEND_WITHDRAW',
        args,
        config,
        clients,
        memory,
        requireObligation: true,
        validateBalance: false
      }),

    suilend_borrow: async (args) =>
      runSuilendWrite({
        kind: 'borrow',
        actionType: 'SUILEND_BORROW',
        args,
        config,
        clients,
        memory,
        requireObligation: true,
        validateBalance: false,
        simulateHealthFactor: true
      }),

    suilend_repay: async (args) =>
      runSuilendWrite({
        kind: 'repay',
        actionType: 'SUILEND_REPAY',
        args,
        config,
        clients,
        memory,
        requireObligation: true,
        validateBalance: true
      }),

    post_action_update: postActionUpdate,

    post_deposit_update: async (args) =>
      postActionUpdate({
        ...args,
        actionId: typeof args.actionId === 'string' ? args.actionId : args.depositId
      }),

    get_swap_quote: async (args) => {
      if (!config.swap.enableQuotes) {
        return { ok: false, error: 'Swap quotes are disabled' };
      }

      const quote = await clients.swap.getQuote({
        network: readNetworkArg(args.network, config.swap.quoteNetwork),
        sellToken: readStringArg(args.sellToken, config.swap.quoteSellToken),
        buyToken: readStringArg(args.buyToken, config.swap.quoteBuyToken),
        sellAmount: readStringArg(args.sellAmount, config.swap.quoteSellAmount),
        slippage: readNumberArg(args.slippage, config.swap.maxSlippagePercent),
        maxSlippage: readNumberArg(args.maxSlippage, config.swap.maxSlippagePercent),
        user: config.agent.walletAddress
      });

      return {
        ok: true,
        bestRoute: quote.bestRoute ? summarizeRoute(quote.bestRoute) : null,
        totalAggregators: quote.data?.totalAggregators ?? quote.aggregators?.length ?? 0,
        validRoutes: quote.validRoutes.map(summarizeRoute)
      };
    },

    get_moltx_global_feed: async (args) => {
      const limit = readNumberArg(args.limit, 10);
      const type = sanitizeFeedType(args.type);

      try {
        const result = await clients.social.globalFeed(
          type !== undefined ? { limit, type } : { limit }
        );
        return { ok: true, ...result };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!type || !message.includes('HTTP 400')) {
          throw error;
        }

        const fallback = await clients.social.globalFeed({ limit });
        return {
          ok: true,
          fallbackUsed: true,
          fallbackReason: `Feed filter rejected by MoltX: ${type}`,
          ...fallback
        };
      }
    },

    inspect_runtime_policy: async () => {
      const treasuryEnabled =
        !config.runtime.dryRun && config.sui.enabled && config.sui.enablePositionCreation;

      return {
        ok: true,
        policy: {
          dryRun: config.runtime.dryRun,
          suiNetwork: config.sui.network,
          suiRpcUrl: config.sui.rpcUrl ? '(configured)' : '(missing)',
          enableSwapQuotes: config.swap.enableQuotes,
          enableAutonomousSwaps: config.swap.enableAutonomousSwaps,
          enableXPosting: config.x.enablePosting,
          enableSuiLending: config.sui.enabled,
          enableSuiPositionCreation: config.sui.enablePositionCreation,
          enableSuiBorrow: config.sui.enableBorrow,
          autoSupplyIntent: treasuryEnabled,
          maxSlippagePercent: config.swap.maxSlippagePercent,
          maxPriceImpactPercent: config.swap.maxPriceImpactPercent,
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

interface SuilendWriteOptions {
  kind: PositionActionKind;
  actionType: Extract<
    AgentAction['type'],
    'SUILEND_SUPPLY' | 'SUILEND_WITHDRAW' | 'SUILEND_BORROW' | 'SUILEND_REPAY'
  >;
  args: ToolArgs;
  config: AppConfig;
  clients: Clients;
  memory: AgentMemoryContext;
  requireObligation: boolean;
  validateBalance: boolean;
  simulateHealthFactor?: boolean;
}

async function runSuilendWrite(options: SuilendWriteOptions): Promise<Record<string, unknown>> {
  const { kind, actionType, args, config, clients, memory, requireObligation, validateBalance, simulateHealthFactor } =
    options;

  const asset = resolveAsset(args, config);
  if (!asset) {
    return { ok: false, blocked: true, reason: 'asset is required (or use market shorthand usdc/sui)', dryRun: config.runtime.dryRun };
  }

  const coinType = clients.suilend.resolveCoinType(asset);
  const rawAmount = readStringArg(args.rawAmount, '0');

  const memorySkip = shouldSkipWriteAction(memory.state, config, asset, kind);
  if (memorySkip.skip) {
    return { ok: false, blocked: true, reason: memorySkip.reason, dryRun: config.runtime.dryRun };
  }

  let amount: bigint;
  try {
    amount = BigInt(rawAmount);
  } catch {
    return { ok: false, blocked: true, reason: 'rawAmount must be a valid integer string', dryRun: config.runtime.dryRun };
  }

  if (amount <= 0n) {
    return { ok: false, blocked: true, reason: 'rawAmount must be greater than zero', dryRun: config.runtime.dryRun };
  }

  let obligation: SuilendObligationResponse | undefined;
  if (requireObligation || simulateHealthFactor) {
    const fetchedObligation = await clients.suilend.getObligation(config.agent.walletAddress);
    obligation = fetchedObligation;
    if (requireObligation && (!fetchedObligation.obligationId || !fetchedObligation.obligationOwnerCapId)) {
      return {
        ok: false,
        blocked: true,
        reason: 'No Suilend obligation found for wallet',
        dryRun: config.runtime.dryRun
      };
    }
  }

  if (validateBalance && config.agent.walletAddress) {
    const balances = await clients.suiExecution.getCoinBalances(config.agent.walletAddress);
    const balanceRaw = balanceRawForCoinType(balances, coinType, config);

    if (kind === 'supply' && coinType.toLowerCase() === config.sui.usdcCoinType.toLowerCase()) {
      if (balanceRaw < config.sui.minIdleRaw) {
        return {
          ok: false,
          blocked: true,
          reason: `Wallet USDC balance ${balances.usdc.formatted} is below MIN_IDLE_USDC_RAW`,
          dryRun: config.runtime.dryRun
        };
      }
    }

    if (balanceRaw < amount) {
      return {
        ok: false,
        blocked: true,
        reason: `rawAmount exceeds wallet balance (${balanceRaw.toString()})`,
        dryRun: config.runtime.dryRun
      };
    }
  }

  const details: Record<string, unknown> = {
    asset,
    coinType,
    rawAmount
  };

  if (obligation?.obligationId) {
    details.obligationId = obligation.obligationId;
  }
  if (obligation?.obligationOwnerCapId) {
    details.obligationOwnerCapId = obligation.obligationOwnerCapId;
  }

  if (simulateHealthFactor) {
    if (!obligation) {
      return {
        ok: false,
        blocked: true,
        reason: 'Unable to load Suilend obligation for health factor simulation',
        dryRun: config.runtime.dryRun
      };
    }

    const borrowUsd = await estimateBorrowUsd(clients, coinType, rawAmount);
    details.projectedHealthFactor = clients.suilend.simulateHealthFactorAfterBorrow(obligation, borrowUsd);
    details.projectedBorrowUsd = borrowUsd;
  }

  const action: AgentAction = { type: actionType, details };
  const decision = evaluateActionPolicy(action, config);
  if (!decision.allowed) {
    return { ok: false, blocked: true, reason: decision.reason, dryRun: config.runtime.dryRun };
  }

  if (config.runtime.dryRun) {
    const record = recordPositionAction(memory.state, {
      runId: memory.runId,
      protocol: 'suilend',
      action: kind,
      asset,
      rawAmount,
      ...(obligation?.obligationId ? { obligationId: obligation.obligationId } : {}),
      status: 'planned',
      dryRun: true
    });
    await memory.persist({ durable: false });

    return {
      ok: true,
      dryRun: true,
      plannedAction: {
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

  let result;
  switch (kind) {
    case 'supply':
      result = await clients.suilend.executeSupply({
        coinType,
        rawAmount,
        obligationOwnerCapId: obligation?.obligationOwnerCapId ?? undefined,
        obligationId: obligation?.obligationId ?? undefined
      });
      break;
    case 'withdraw':
      result = await clients.suilend.executeWithdraw({
        coinType,
        rawAmount,
        obligationOwnerCapId: obligation!.obligationOwnerCapId!,
        obligationId: obligation!.obligationId!
      });
      break;
    case 'borrow':
      result = await clients.suilend.executeBorrow({
        coinType,
        rawAmount,
        obligationOwnerCapId: obligation!.obligationOwnerCapId!,
        obligationId: obligation!.obligationId!
      });
      break;
    case 'repay':
      result = await clients.suilend.executeRepay({
        coinType,
        rawAmount,
        obligationId: obligation!.obligationId!
      });
      break;
  }

  const record = recordPositionAction(memory.state, {
    runId: memory.runId,
    protocol: 'suilend',
    action: kind,
    asset,
    rawAmount,
    ...(obligation?.obligationId ? { obligationId: obligation.obligationId } : {}),
    status: 'confirmed',
    digest: result.digest,
    dryRun: false
  });
  await memory.persist({ durable: true });

  return {
    ok: true,
    dryRun: false,
    recordedActionId: record.id,
    pendingTweet:
      kind === 'supply' && memory.state.pending.some((task) => task.actionId === record.id),
    digest: result.digest,
    result
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
    return {
      ok: false,
      blocked: true,
      reason: 'ENABLE_X_POSTING is false',
      actionId: action.id
    };
  }

  if (!config.x.userAccessToken) {
    return {
      ok: false,
      blocked: true,
      reason: 'X_USER_ACCESS_TOKEN is missing',
      actionId: action.id
    };
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

    return {
      ok: true,
      actionId: action.id,
      tweetId: post.id,
      text,
      recordId: tweet.id
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const tweet = recordTweet(memory.state, {
      actionId: action.id,
      status: 'failed',
      text
    });
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
    reason: !canSupply
      ? skip.reason ?? (meetsMin ? null : 'USDC balance below MIN_IDLE_USDC_RAW')
      : null
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
  const parts = [`Treasury update: supplied ${amount} ${symbol} into Suilend ${market?.symbol ?? 'market'} on Sui.`];

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
): Promise<SuilendMarket | null> {
  try {
    const coinType = clients.suilend.resolveCoinType(action.asset);
    const result = await clients.suilend.getMarkets();
    return (
      result.markets.find((market: SuilendMarket) => market.coinType.toLowerCase() === coinType.toLowerCase()) ??
      null
    );
  } catch {
    return null;
  }
}

function inferActionSymbol(action: AgentPositionActionRecord, market: SuilendMarket | null): string {
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

function defaultComparisonAssets(config: AppConfig): string[] {
  const candidates = [config.sui.defaultAssets.usdc, config.sui.defaultAssets.sui];
  const unique = [...new Set(candidates.map((asset) => asset.toLowerCase()))];

  if (config.sui.allowedAssets.length === 0) {
    return unique;
  }

  return unique.filter((asset) =>
    config.sui.allowedAssets.some((entry) => entry.toLowerCase() === asset)
  );
}

async function estimateBorrowUsd(clients: Clients, coinType: string, rawAmount: string): Promise<number> {
  const result = await clients.suilend.getMarkets();
  const market = result.markets.find(
    (entry: SuilendMarket) => entry.coinType.toLowerCase() === coinType.toLowerCase()
  );
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
          limit: { type: 'number', minimum: 1, maximum: 20, description: 'Max memories to return (default 5).' }
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
      description: 'Read Suilend obligation positions, health factor, and borrow limits for the configured wallet.',
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
      name: 'suilend_supply',
      description:
        'Supply collateral into Suilend. Blocked while tweet_action is pending or within action cooldown. Respects policy, dry-run, and SUI_ALLOWED_ASSETS.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: {
            type: 'string',
            enum: ['usdc', 'sui'],
            description: 'Optional configured shorthand for a default asset.'
          },
          asset: {
            type: 'string',
            description: 'Asset shorthand (usdc, sui) or full coin type. Required unless market resolves it.'
          },
          coinType: {
            type: 'string',
            description: 'Full Sui coin type. Alternative to asset.'
          },
          rawAmount: {
            type: 'string',
            description: 'Raw token amount in smallest units to supply.'
          }
        },
        required: ['rawAmount']
      }
    },
    {
      type: 'function',
      name: 'suilend_withdraw',
      description: 'Withdraw supplied collateral from Suilend.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: { type: 'string', enum: ['usdc', 'sui'] },
          asset: { type: 'string' },
          coinType: { type: 'string' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to withdraw.' }
        },
        required: ['rawAmount', 'asset']
      }
    },
    {
      type: 'function',
      name: 'suilend_borrow',
      description:
        'Borrow from Suilend. Simulates projected health factor and blocks if below SUI_MIN_HEALTH_FACTOR.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: { type: 'string', enum: ['usdc', 'sui'] },
          asset: { type: 'string' },
          coinType: { type: 'string' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to borrow.' }
        },
        required: ['rawAmount', 'asset']
      }
    },
    {
      type: 'function',
      name: 'suilend_repay',
      description: 'Repay borrowed debt on Suilend.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: { type: 'string', enum: ['usdc', 'sui'] },
          asset: { type: 'string' },
          coinType: { type: 'string' },
          rawAmount: { type: 'string', description: 'Raw token amount in smallest units to repay.' }
        },
        required: ['rawAmount', 'asset']
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
          actionId: { type: 'string', description: 'Position action id from agent memory or suilend_supply result.' },
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
    },
    {
      type: 'function',
      name: 'get_swap_quote',
      description: 'Get a MoltX best-route swap quote. This only quotes; it does not execute a transaction.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          network: { type: 'string', enum: ['ethereum', 'arbitrum', 'base', 'polygon', 'plasma'] },
          sellToken: { type: 'string', description: 'Token address to sell.' },
          buyToken: { type: 'string', description: 'Token address to buy.' },
          sellAmount: { type: 'string', description: 'Raw token amount in smallest units.' },
          slippage: { type: 'number', description: 'Maximum acceptable slippage percentage.' },
          maxSlippage: { type: 'number', description: 'Maximum slippage threshold.' }
        },
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_moltx_global_feed',
      description: 'Read the MoltX global social feed for context before posting.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 50 },
          type: {
            type: 'string',
            description: 'Optional comma-separated content types from: post, quote, repost, reply, article.'
          }
        },
        required: []
      }
    }
  ];
}

function summarizeRoute(route: SwapRoute): Record<string, unknown> {
  return {
    aggregator: route.displayName,
    sellTokenAmount: route.data?.sellTokenAmount,
    buyTokenAmount: route.data?.buyTokenAmount,
    priceImpact: route.data?.priceImpact,
    allowanceSpender: route.data?.allowanceSpender,
    to: route.data?.to,
    value: route.data?.value
  };
}

function redactToolArgs(toolName: string, args: ToolArgs): Record<string, unknown> {
  if (
    toolName === 'suilend_supply' ||
    toolName === 'suilend_withdraw' ||
    toolName === 'suilend_borrow' ||
    toolName === 'suilend_repay'
  ) {
    return {
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

function readNetworkArg(value: unknown, fallback: NetworkName): NetworkName {
  if (
    value === 'ethereum' ||
    value === 'arbitrum' ||
    value === 'base' ||
    value === 'polygon' ||
    value === 'plasma'
  ) {
    return value;
  }

  return fallback;
}

function sanitizeFeedType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const allowedTypes = new Set(['post', 'quote', 'repost', 'reply', 'article']);
  const valid = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => allowedTypes.has(part));

  return valid.length > 0 ? valid.join(',') : undefined;
}
