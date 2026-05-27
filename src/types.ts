import type { FluidClient } from './clients/fluidClient.js';
import type { LaunchpadClient } from './clients/launchpadClient.js';
import type { MoltxSocialClient } from './clients/moltxSocialClient.js';
import type { MoltxSwapClient } from './clients/moltxSwapClient.js';
import type { OpenAIResponsesClient } from './clients/openaiResponsesClient.js';
import type { createLogger } from './utils/logger.js';

export type Logger = ReturnType<typeof createLogger>;

export interface AppConfig {
  runtime: {
    dryRun: boolean;
    nodeEnv: string;
    autonomyIntervalMs: number;
  };
  logLevel: string;
  agent: {
    name: string;
    walletAddress: string;
    mission: string;
  };
  openai: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxToolRounds: number;
  };
  moltx: {
    apiBase: string;
    apiKey: string;
    postUpdates: boolean;
  };
  swap: {
    baseUrl: string;
    enableQuotes: boolean;
    enableAutonomousSwaps: boolean;
    quoteNetwork: NetworkName;
    quoteSellToken: string;
    quoteBuyToken: string;
    quoteSellAmount: string;
    maxSlippagePercent: number;
    maxPriceImpactPercent: number;
  };
  fluid: {
    baseUrl: string;
    enabled: boolean;
    minIdleUsdcRaw: bigint;
  };
  launchpad: {
    baseUrl: string;
    enabled: boolean;
  };
}

export interface Clients {
  social: MoltxSocialClient;
  swap: MoltxSwapClient;
  fluid: FluidClient;
  launchpad: LaunchpadClient;
  openai: OpenAIResponsesClient;
}

export type NetworkName = 'ethereum' | 'arbitrum' | 'base' | 'polygon' | 'plasma';

export interface FluidPosition {
  fToken: string;
  symbol: string;
  name: string;
  underlying: string;
  isNativeUnderlying: boolean;
  decimals: number;
  totalAssets: string;
  totalSupply: string;
  supplyRate: number;
  rewardsRate: number;
  totalApr: number;
  userShares: string;
  userAssets: string;
  userBalance: string;
}

export interface FluidPositionsResponse {
  positions?: FluidPosition[];
  [key: string]: unknown;
}

export interface TokenInfo {
  address: string;
  name?: string;
  symbol: string;
  decimals: number;
  price?: number;
  chainId?: string | number;
  logoURI?: string;
  coingeckoId?: string;
}

export interface SwapRoute {
  name: string;
  displayName: string;
  iconURL?: string;
  data?: {
    sellToken?: TokenInfo;
    buyToken?: TokenInfo;
    sellTokenAmount?: string;
    buyTokenAmount?: string;
    unitAmt?: string;
    slippage?: string;
    priceImpact?: string;
    calldata?: string;
    to?: string;
    allowanceSpender?: string;
    gas?: number;
    gasPrice?: string | number;
    value?: string;
    raw?: Record<string, unknown>;
  };
  error?: {
    message: string;
  };
}

export interface SwapResponse {
  data?: {
    totalAggregators?: number;
    [key: string]: unknown;
  };
  aggregators?: SwapRoute[];
  validRoutes: SwapRoute[];
  bestRoute: SwapRoute | null;
  [key: string]: unknown;
}

export interface OpenAIResponse {
  output?: OpenAIOutputItem[];
  output_text?: string;
  [key: string]: unknown;
}

export type OpenAIOutputItem = OpenAIMessageItem | OpenAIFunctionCallItem | Record<string, unknown>;

export interface OpenAIMessageItem {
  type: 'message';
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface OpenAIFunctionCallItem {
  type: 'function_call';
  name: string;
  call_id: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface OpenAIToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIInputItem {
  type?: string;
  role?: string;
  call_id?: string;
  output?: string;
  content?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export type AgentAction =
  | { type: 'OBSERVE'; summary: string; details?: Record<string, unknown> }
  | { type: 'SOCIAL_POST'; content: string }
  | { type: 'SWAP_EXECUTE'; route?: SwapRoute | null; details?: Record<string, unknown> }
  | { type: 'FLUID_SUPPLY'; details?: Record<string, unknown> }
  | { type: 'TOKEN_LAUNCH'; details?: Record<string, unknown> };

export interface StrategyResult {
  observations: Array<{ summary: string; details?: Record<string, unknown> }>;
  actions: AgentAction[];
}
