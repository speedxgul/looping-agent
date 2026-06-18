import type { FluidClient } from './clients/fluidClient.js';
import type { FluidExecutionClient } from './clients/fluidExecutionClient.js';
import type { MoltxSocialClient } from './clients/moltxSocialClient.js';
import type { MoltxSwapClient } from './clients/moltxSwapClient.js';
import type { OpenAIResponsesClient } from './clients/openaiResponsesClient.js';
import type { XClient } from './clients/xClient.js';
import type { WalrusBlobClient } from './clients/walrusBlobClient.js';
import type { WalrusMemoryClient } from './clients/walrusMemoryClient.js';
import type { createLogger } from './utils/logger.js';

export type MemoryBackend = 'file' | 'walrus';

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
    statePath: string;
    depositCooldownMs: number;
  };
  openai: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxToolRounds: number;
  };
  moltx: {
    apiBase: string;
  };
  x: {
    enablePosting: boolean;
    userAccessToken: string;
    apiBase: string;
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
    enablePositionCreation: boolean;
    minIdleUsdcRaw: bigint;
    maxSupplyAmountRaw: bigint;
    allowedFTokens: string[];
    defaultFTokens: {
      usdc: string;
      weth: string;
    };
  };
  evm: {
    accountMode: 'eoa' | 'smart';
    baseRpcUrl: string;
    privateKey: string;
    smartAccountType: 'coinbase';
    smartAccountBundlerUrl: string;
    smartAccountUsePaymaster: boolean;
  };
  walrus: {
    /** Where the durable agent state lives: local file or Walrus blobs. */
    memoryBackend: MemoryBackend;
    /** Walrus HTTP publisher base URL (testnet by default). */
    publisherUrl: string;
    /** Walrus HTTP aggregator base URL (testnet by default). */
    aggregatorUrl: string;
    /** Number of Walrus storage epochs to persist each blob for. */
    epochs: number;
    /** Optional blob id to bootstrap/restore state from on a fresh machine. */
    stateBlobId: string;
    memwal: {
      /** Enables MemWal semantic memory (recall/remember). */
      enabled: boolean;
      /** MemWalAccount object id on Sui. */
      accountId: string;
      /** Ed25519 delegate private key (hex). */
      delegateKey: string;
      /** MemWal relayer URL (staging by default). */
      relayerUrl: string;
      /** Namespace that isolates this agent's memories. */
      namespace: string;
    };
  };
}

export interface Clients {
  social: MoltxSocialClient;
  swap: MoltxSwapClient;
  fluid: FluidClient;
  fluidExecution: FluidExecutionClient;
  openai: OpenAIResponsesClient;
  x: XClient;
  walrusBlob: WalrusBlobClient;
  walrusMemory: WalrusMemoryClient;
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

export interface FluidMarket {
  fToken: string;
  underlying: string;
  symbol: string;
  name: string;
  decimals: number;
  isNativeUnderlying: boolean;
  /** Liquidity-layer supply APR (percent, e.g. 5.19 = 5.19%). */
  supplyRate: number;
  /** Native on-chain reward APR added to supply (percent). */
  rewardsRate: number;
  /** supplyRate + rewardsRate from Fluid API totalRate (percent). */
  totalApr: number;
  /** Underlying asset staking APR when present (percent); not included in totalApr. */
  stakingApr?: number;
  /** Sum of Fluid merkle reward APRs when present (percent); not included in totalApr. */
  merkleRewardsApr?: number;
  totalAssets: string;
  chain?: string;
}

export interface FluidMarketsResponse {
  markets?: FluidMarket[];
  [key: string]: unknown;
}

export interface WalletTokenBalance {
  symbol: string;
  address: string;
  decimals: number;
  raw: string;
  formatted: string;
}

export interface WalletBalancesResponse {
  wallet: string;
  eth: WalletTokenBalance;
  usdc: WalletTokenBalance;
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
  | { type: 'SWAP_EXECUTE'; route?: SwapRoute | null; details?: Record<string, unknown> }
  | { type: 'FLUID_SUPPLY'; details?: Record<string, unknown> };

export interface StrategyResult {
  observations: Array<{ summary: string; details?: Record<string, unknown> }>;
  actions: AgentAction[];
}
