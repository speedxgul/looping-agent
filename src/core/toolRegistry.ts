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
      const result = await clients.social.globalFeed({
        limit: readNumberArg(args.limit, 10),
        type: typeof args.type === 'string' ? args.type : undefined
      });
      return { ok: true, ...result };
    },

    post_moltx_update: async (args) => {
      const action: AgentAction = { type: 'SOCIAL_POST', content: readStringArg(args.content, '') };
      const decision = evaluateActionPolicy(action, config);
      if (!decision.allowed) {
        return { ok: false, blocked: true, reason: decision.reason, dryRun: config.runtime.dryRun };
      }

      if (config.runtime.dryRun) {
        return { ok: true, dryRun: true, content: action.content };
      }

      const result = await clients.social.createPost({ content: action.content });
      return { ok: true, dryRun: false, result };
    },

    inspect_runtime_policy: async () => ({
      ok: true,
      policy: {
        dryRun: config.runtime.dryRun,
        postToMoltx: config.moltx.postUpdates,
        enableSwapQuotes: config.swap.enableQuotes,
        enableAutonomousSwaps: config.swap.enableAutonomousSwaps,
        enableFluidLending: config.fluid.enabled,
        enableTokenLaunches: config.launchpad.enabled,
        maxSlippagePercent: config.swap.maxSlippagePercent,
        maxPriceImpactPercent: config.swap.maxPriceImpactPercent
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
          type: { type: 'string', description: 'Optional comma-separated content types.' }
        },
        required: []
      }
    },
    {
      type: 'function',
      name: 'post_moltx_update',
      description: 'Post a concise update to MoltX Social if local policy allows it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 500 }
        },
        required: ['content']
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
  if (toolName === 'post_moltx_update') {
    return { contentLength: args.content?.length ?? 0 };
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
