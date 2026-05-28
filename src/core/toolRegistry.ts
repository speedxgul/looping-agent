import { evaluateActionPolicy } from './policy.js';
import type {
  AgentAction,
  AppConfig,
  Clients,
  Logger,
  NetworkName,
  OpenAIFunctionCallItem,
  OpenAIToolDefinition,
  SwapRoute
} from '../types.js';

interface ToolRegistryOptions {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
}

type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => Promise<Record<string, unknown>>;

export function createToolRegistry({ config, clients, logger }: ToolRegistryOptions) {
  const handlers: Record<string, ToolHandler> = {
    get_fluid_positions: async () => {
      if (!config.agent.walletAddress) {
        return { ok: false, error: 'AGENT_WALLET_ADDRESS is not configured' };
      }

      if (!config.fluid.enabled) {
        return { ok: false, error: 'Fluid lending is disabled' };
      }

      const result = await clients.fluid.getPositions(config.agent.walletAddress);
      return { ok: true, wallet: config.agent.walletAddress, ...result };
    },

    create_fluid_position: async (args) => {
      const action: AgentAction = {
        type: 'FLUID_SUPPLY',
        details: {
          fTokenAddress: resolveFTokenAddress(args, config),
          rawAmount: readStringArg(args.rawAmount, '0'),
          underlyingTokenAddress: typeof args.underlyingTokenAddress === 'string' ? args.underlyingTokenAddress : undefined,
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
        return {
          ok: true,
          dryRun: true,
          plannedAction: {
            fTokenAddress: details.fTokenAddress,
            underlyingTokenAddress: details.underlyingTokenAddress,
            rawAmount: details.rawAmount,
            isNativeUnderlying: details.isNativeUnderlying ?? false
          }
        };
      }

      await clients.fluidExecution.assertWalletMatches();
      const result = await clients.fluidExecution.supplyToFluid({
        fTokenAddress: String(details.fTokenAddress),
        rawAmount: String(details.rawAmount),
        underlyingTokenAddress:
          typeof details.underlyingTokenAddress === 'string' ? details.underlyingTokenAddress : undefined,
        isNativeUnderlying: Boolean(details.isNativeUnderlying)
      });

      return { ok: true, dryRun: false, result };
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

    inspect_runtime_policy: async () => ({
      ok: true,
      policy: {
        dryRun: config.runtime.dryRun,
        accountMode: config.evm.accountMode,
        smartAccountType: config.evm.accountMode === 'smart' ? config.evm.smartAccountType : undefined,
        enableSwapQuotes: config.swap.enableQuotes,
        enableAutonomousSwaps: config.swap.enableAutonomousSwaps,
        enableFluidLending: config.fluid.enabled,
        enableFluidPositionCreation: config.fluid.enablePositionCreation,
        maxSlippagePercent: config.swap.maxSlippagePercent,
        maxPriceImpactPercent: config.swap.maxPriceImpactPercent,
        maxFluidSupplyAmountRaw: config.fluid.maxSupplyAmountRaw.toString(),
        allowedFTokens: config.fluid.allowedFTokens,
        configuredDefaultFTokens: config.fluid.defaultFTokens
      }
    })
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

function definitions(): OpenAIToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'inspect_runtime_policy',
      description: 'Inspect local runtime safety policy and enabled actions.',
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
      name: 'create_fluid_position',
      description: 'Create or add to a Fluid lending position on Base by approving the underlying token and depositing into the specified fToken market. Only call when policy allows and only with a configured allowlisted market.',
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
            description: 'Underlying ERC-20 token address. Omit only for native ETH deposits.'
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
    },
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
