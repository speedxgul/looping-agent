import {
  BASE_USDC_ADDRESS,
  getMemorySummary,
  recordDeposit,
  recordTweet,
  shouldSkipDeposit,
  updateSnapshots,
  type AgentDepositRecord,
  type AgentStateV1
} from './agentMemory.js';
import { evaluateActionPolicy } from './policy.js';
import { formatUnits } from '../utils/amounts.js';
import type {
  AgentAction,
  AppConfig,
  Clients,
  FluidMarket,
  Logger,
  NetworkName,
  OpenAIFunctionCallItem,
  OpenAIToolDefinition,
  SwapRoute
} from '../types.js';

export interface AgentMemoryContext {
  state: AgentStateV1;
  runId: string;
  statePath: string;
  persist: () => void;
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
  const handlers: Record<string, ToolHandler> = {
    get_agent_memory: async () => ({
      ok: true,
      memory: getMemorySummary(memory.state, config, memory.runId)
    }),

    get_fluid_positions: async () => {
      if (!config.agent.walletAddress) {
        return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
      }

      if (!config.fluid.enabled) {
        return { ok: false, error: 'Fluid lending is disabled' };
      }

      const result = await clients.fluid.getPositions(config.agent.walletAddress);
      updateSnapshots(memory.state, { lastFluidPositions: result });
      memory.persist();
      return { ok: true, wallet: config.agent.walletAddress, ...result };
    },

    get_wallet_balances: async () => {
      if (!config.agent.walletAddress) {
        return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
      }

      if (!config.evm.baseRpcUrl) {
        return { ok: false, error: 'BASE_RPC_URL is required to read wallet balances' };
      }

      const balances = await clients.fluidExecution.getWalletBalances(config.agent.walletAddress);
      const usdcRaw = BigInt(balances.usdc.raw);
      const hints = buildDepositHints(config, usdcRaw, memory.state);

      updateSnapshots(memory.state, { lastUsdcBalanceRaw: balances.usdc.raw });
      memory.persist();

      return {
        ok: true,
        ...balances,
        baseUsdcAddress: BASE_USDC_ADDRESS,
        treasury: hints
      };
    },

    create_fluid_position: async (args) => {
      const fTokenAddress = resolveFTokenAddress(args, config);
      const rawAmount = readStringArg(args.rawAmount, '0');
      const underlyingTokenAddress =
        typeof args.underlyingTokenAddress === 'string'
          ? args.underlyingTokenAddress
          : BASE_USDC_ADDRESS;

      const memorySkip = shouldSkipDeposit(memory.state, config, fTokenAddress);
      if (memorySkip.skip) {
        return { ok: false, blocked: true, reason: memorySkip.reason, dryRun: config.runtime.dryRun };
      }

      if (!config.evm.baseRpcUrl) {
        return { ok: false, blocked: true, reason: 'BASE_RPC_URL is missing', dryRun: config.runtime.dryRun };
      }

      if (config.agent.walletAddress) {
        const balances = await clients.fluidExecution.getWalletBalances(config.agent.walletAddress);
        const usdcRaw = BigInt(balances.usdc.raw);
        const amount = BigInt(rawAmount);

        if (amount <= 0n) {
          return { ok: false, blocked: true, reason: 'rawAmount must be greater than zero', dryRun: config.runtime.dryRun };
        }

        if (usdcRaw < config.fluid.minIdleUsdcRaw) {
          return {
            ok: false,
            blocked: true,
            reason: `Wallet USDC balance ${balances.usdc.formatted} is below MIN_IDLE_USDC_RAW`,
            dryRun: config.runtime.dryRun
          };
        }

        if (amount > usdcRaw) {
          return {
            ok: false,
            blocked: true,
            reason: `rawAmount exceeds wallet USDC balance (${balances.usdc.raw})`,
            dryRun: config.runtime.dryRun
          };
        }
      }

      const action: AgentAction = {
        type: 'FLUID_SUPPLY',
        details: {
          fTokenAddress,
          rawAmount,
          underlyingTokenAddress,
          isNativeUnderlying: readBooleanArg(args.isNativeUnderlying, false),
          symbol: typeof args.symbol === 'string' ? args.symbol : undefined
        }
      };
      const decision = evaluateActionPolicy(action, config);
      if (!decision.allowed) {
        return { ok: false, blocked: true, reason: decision.reason, dryRun: config.runtime.dryRun };
      }

      const details = action.details ?? {};
      if (config.runtime.dryRun) {
        const deposit = recordDeposit(memory.state, {
          runId: memory.runId,
          fToken: String(details.fTokenAddress),
          rawAmount: String(details.rawAmount),
          ...(typeof details.symbol === 'string' ? { symbol: details.symbol } : {}),
          underlying: underlyingTokenAddress,
          status: 'planned',
          dryRun: true
        });
        memory.persist();

        return {
          ok: true,
          dryRun: true,
          plannedAction: {
            fTokenAddress: details.fTokenAddress,
            underlyingTokenAddress: details.underlyingTokenAddress,
            rawAmount: details.rawAmount,
            isNativeUnderlying: details.isNativeUnderlying ?? false
          },
          recordedDepositId: deposit.id
        };
      }

      await clients.fluidExecution.assertWalletMatches();
      const result = await clients.fluidExecution.supplyToFluid({
        fTokenAddress: String(details.fTokenAddress),
        rawAmount: String(details.rawAmount),
        underlyingTokenAddress,
        isNativeUnderlying: Boolean(details.isNativeUnderlying)
      });

      const txHash = typeof result.txHash === 'string' ? result.txHash : undefined;
      const deposit = recordDeposit(memory.state, {
        runId: memory.runId,
        fToken: String(details.fTokenAddress),
        rawAmount: String(details.rawAmount),
        ...(typeof details.symbol === 'string' ? { symbol: details.symbol } : {}),
        underlying: underlyingTokenAddress,
        status: 'confirmed',
        ...(txHash ? { txHash } : {}),
        dryRun: false
      });
      memory.persist();

      return {
        ok: true,
        dryRun: false,
        recordedDepositId: deposit.id,
        pendingTweet: memory.state.pending.some((task) => task.depositId === deposit.id),
        result
      };
    },

    post_deposit_update: async (args) => {
      const depositId = typeof args.depositId === 'string' ? args.depositId : undefined;
      const pending = memory.state.pending.find((task) => task.type === 'tweet_deposit');

      if (!depositId && !pending) {
        return { ok: false, error: 'No pending tweet_deposit task and no depositId provided' };
      }

      const targetDepositId = depositId ?? pending?.depositId;
      const deposit = memory.state.actions.deposits.find((entry) => entry.id === targetDepositId);
      if (!deposit) {
        return { ok: false, error: `Deposit not found: ${targetDepositId}` };
      }

      if (deposit.status !== 'confirmed' || deposit.dryRun) {
        return {
          ok: false,
          blocked: true,
          reason: 'Only confirmed live deposits can be posted to X',
          depositId: deposit.id
        };
      }

      if (deposit.tweeted) {
        return { ok: true, alreadyPosted: true, depositId: deposit.id, tweetId: deposit.tweetId ?? null };
      }

      if (!config.x.enablePosting) {
        return {
          ok: false,
          blocked: true,
          reason: 'ENABLE_X_POSTING is false',
          depositId: deposit.id
        };
      }

      if (!config.x.userAccessToken) {
        return {
          ok: false,
          blocked: true,
          reason: 'X_USER_ACCESS_TOKEN is missing',
          depositId: deposit.id
        };
      }

      const text =
        typeof args.text === 'string' && args.text.trim()
          ? args.text.trim()
          : await buildDefaultDepositPostText(deposit, clients);

      try {
        const post = await clients.x.createPost(text);
        const tweet = recordTweet(memory.state, {
          depositId: deposit.id,
          status: 'posted',
          externalId: post.id,
          text
        });
        memory.persist();

        return {
          ok: true,
          depositId: deposit.id,
          tweetId: post.id,
          text,
          recordId: tweet.id
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const tweet = recordTweet(memory.state, {
          depositId: deposit.id,
          status: 'failed',
          text
        });
        memory.persist();

        return {
          ok: false,
          blocked: true,
          reason: message,
          depositId: deposit.id,
          failedTweetRecordId: tweet.id,
          text
        };
      }
    },

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

    get_fluid_markets: async (args) => {
      if (!config.fluid.enabled) {
        return { ok: false, error: 'Fluid lending is disabled' };
      }

      const chain = readStringArg(args.chain, 'base');
      const result = await clients.fluidExecution.getMarkets();
      const markets = result.markets ?? [];

      const ranked = markets.map((m, index) => ({
        rank: index + 1,
        fToken: m.fToken,
        underlying: m.underlying,
        symbol: m.symbol,
        name: m.name,
        decimals: m.decimals,
        isNativeUnderlying: m.isNativeUnderlying,
        totalApr: m.totalApr,
        supplyRate: m.supplyRate,
        rewardsRate: m.rewardsRate,
        stakingApr: m.stakingApr,
        merkleRewardsApr: m.merkleRewardsApr,
        totalAssets: m.totalAssets
      }));

      if (ranked[0]) {
        updateSnapshots(memory.state, {
          lastTopMarketSymbol: ranked[0].symbol,
          lastTopMarketFToken: ranked[0].fToken
        });
        memory.persist();
      }

      return {
        ok: true,
        chain,
        count: ranked.length,
        rateSource: 'https://api.fluid.instadapp.io/v2/lending/8453/tokens',
        rateNotes:
          'totalApr = supplyRate + native rewardsRate. stakingApr and merkleRewardsApr are extra yield not included in totalApr. Markets are sorted by totalApr descending.',
        topMarket: ranked[0] ?? null,
        markets: ranked
      };
    },

    get_moltx_global_feed: async (args) => {
      const limit = readNumberArg(args.limit, 10);
      const type = sanitizeFeedType(args.type);

      try {
        const result = await clients.social.globalFeed({ limit, type });
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
        !config.runtime.dryRun && config.fluid.enabled && config.fluid.enablePositionCreation;

      return {
        ok: true,
        policy: {
          dryRun: config.runtime.dryRun,
          accountMode: config.evm.accountMode,
          smartAccountType: config.evm.accountMode === 'smart' ? config.evm.smartAccountType : undefined,
          enableSwapQuotes: config.swap.enableQuotes,
          enableAutonomousSwaps: config.swap.enableAutonomousSwaps,
          enableXPosting: config.x.enablePosting,
          enableFluidLending: config.fluid.enabled,
          enableFluidPositionCreation: config.fluid.enablePositionCreation,
          autoDepositIntent: treasuryEnabled,
          maxSlippagePercent: config.swap.maxSlippagePercent,
          maxPriceImpactPercent: config.swap.maxPriceImpactPercent,
          minIdleUsdcRaw: config.fluid.minIdleUsdcRaw.toString(),
          maxFluidSupplyAmountRaw: config.fluid.maxSupplyAmountRaw.toString(),
          depositCooldownMs: config.agent.depositCooldownMs,
          baseUsdcAddress: BASE_USDC_ADDRESS,
          allowedFTokens: config.fluid.allowedFTokens,
          configuredDefaultFTokens: config.fluid.defaultFTokens,
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

function buildDepositHints(config: AppConfig, usdcRaw: bigint, state: AgentStateV1) {
  const skip = shouldSkipDeposit(state, config);
  const meetsMin = usdcRaw >= config.fluid.minIdleUsdcRaw;
  const canDeposit = !skip.skip && meetsMin;
  const depositableRaw = canDeposit
    ? usdcRaw < config.fluid.maxSupplyAmountRaw
      ? usdcRaw
      : config.fluid.maxSupplyAmountRaw
    : 0n;

  return {
    minIdleUsdcRaw: config.fluid.minIdleUsdcRaw.toString(),
    maxSupplyAmountRaw: config.fluid.maxSupplyAmountRaw.toString(),
    usdcBalanceRaw: usdcRaw.toString(),
    canDeposit,
    depositableRaw: depositableRaw.toString(),
    suggestedMarket: 'usdc',
    suggestedFToken: config.fluid.defaultFTokens.usdc || null,
    suggestedUnderlying: BASE_USDC_ADDRESS,
    depositSkipReason: skip.reason,
    reason: !canDeposit
      ? skip.reason ?? (meetsMin ? null : 'USDC balance below MIN_IDLE_USDC_RAW')
      : null
  };
}

async function buildDefaultDepositPostText(deposit: AgentDepositRecord, clients: Clients): Promise<string> {
  const market = await findDepositMarket(deposit, clients);
  const symbol = inferUnderlyingSymbol(deposit, market);
  const marketSymbol = market?.symbol ?? 'market';
  const decimals = market?.decimals ?? inferDepositDecimals(deposit);
  const amount = formatUnits(deposit.rawAmount, decimals);
  const parts = [`Treasury update: supplied ${amount} ${symbol} into Fluid ${marketSymbol} on Base.`];

  if (market?.totalApr !== undefined) {
    parts.push(`Current market APR: ~${formatApr(market.totalApr)}%.`);
  }

  if (deposit.txHash) {
    parts.push(`Tx: https://basescan.org/tx/${deposit.txHash}`);
  }

  return parts.join(' ');
}

async function findDepositMarket(deposit: AgentDepositRecord, clients: Clients): Promise<FluidMarket | null> {
  try {
    const result = await clients.fluidExecution.getMarkets();
    return result.markets?.find((market) => market.fToken.toLowerCase() === deposit.fToken.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

function inferUnderlyingSymbol(deposit: AgentDepositRecord, market: FluidMarket | null): string {
  if (deposit.symbol) {
    return deposit.symbol;
  }

  if (deposit.underlying?.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase()) {
    return 'USDC';
  }

  if (market?.symbol?.startsWith('f') && market.symbol.length > 1) {
    return market.symbol.slice(1);
  }

  return market?.symbol ?? 'tokens';
}

function inferDepositDecimals(deposit: AgentDepositRecord): number {
  if (deposit.underlying?.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase() || deposit.symbol === 'USDC') {
    return 6;
  }

  return 18;
}

function formatApr(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function definitions(): OpenAIToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'inspect_runtime_policy',
      description: 'Inspect local runtime safety policy, treasury thresholds, and agent memory summary.',
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
        'Read persistent agent memory: prior runs, deposits, pending tasks (e.g. tweet after deposit), and snapshots.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_fluid_positions',
      description: 'Read Fluid lending positions for the configured wallet on Base.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'get_wallet_balances',
      description:
        'Read Base wallet ETH and USDC balances with deposit hints (min idle, max supply, canDeposit, suggested fUSDC market).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'create_fluid_position',
      description:
        'Supply into a Fluid fToken on Base (approve + deposit). Blocked while tweet_deposit is pending or within deposit cooldown. Use market usdc with FLUID_USDC_FTOKEN configured.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: {
            type: 'string',
            enum: ['usdc', 'weth'],
            description: 'Optional configured shorthand for a default Fluid market.'
          },
          fTokenAddress: {
            type: 'string',
            description: 'Fluid fToken address to deposit into. Required unless a configured market shorthand resolves it.'
          },
          underlyingTokenAddress: {
            type: 'string',
            description: 'Underlying ERC-20 token address. Defaults to Base USDC.'
          },
          rawAmount: {
            type: 'string',
            description: 'Raw token amount in smallest units to supply.'
          },
          isNativeUnderlying: {
            type: 'boolean',
            description: 'Set true only when the Fluid market takes native ETH via depositNative.'
          },
          symbol: {
            type: 'string',
            description: 'Optional token symbol for logs and summaries.'
          }
        },
        required: ['rawAmount']
      }
    },
    {
      type: 'function',
      name: 'post_deposit_update',
      description:
        'Post a status update about a confirmed recorded deposit to X. Use when memory shows pending tweet_deposit.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          depositId: { type: 'string', description: 'Deposit id from agent memory or create_fluid_position result.' },
          text: { type: 'string', description: 'Optional draft post text.' }
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
      name: 'get_fluid_markets',
      description:
        'List Fluid fToken lending markets on Base with live APRs from the Fluid API (supply, native rewards, total, optional staking/merkle). Markets are ranked by totalApr. Use this to pick the best allowlisted pool before create_fluid_position.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chain: {
            type: 'string',
            enum: ['base', 'ethereum', 'arbitrum'],
            description: 'Chain to query markets for. Defaults to base.'
          }
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
  if (toolName === 'create_fluid_position') {
    return {
      market: args.market,
      fTokenAddress: args.fTokenAddress,
      underlyingTokenAddress: args.underlyingTokenAddress,
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

function readBooleanArg(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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

function resolveFTokenAddress(args: ToolArgs, config: AppConfig): string {
  if (typeof args.fTokenAddress === 'string' && args.fTokenAddress) {
    return args.fTokenAddress;
  }

  if (args.market === 'usdc') {
    return config.fluid.defaultFTokens.usdc;
  }

  if (args.market === 'weth') {
    return config.fluid.defaultFTokens.weth;
  }

  return '';
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
