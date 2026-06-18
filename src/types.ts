import type { MoltxSocialClient } from './clients/moltxSocialClient.js';
import type { MoltxSwapClient } from './clients/moltxSwapClient.js';
import type { NaviClient } from './clients/naviClient.js';
import type { OpenAIResponsesClient } from './clients/openaiResponsesClient.js';
import type { ScallopClient } from './clients/scallopClient.js';
import type { SuiExecutionClient } from './clients/sui/suiExecutionClient.js';
import type { SuilendClient } from './clients/suilendClient.js';
import type { XClient } from './clients/xClient.js';
import type { WalrusBlobClient } from './clients/walrusBlobClient.js';
import type { WalrusMemoryClient } from './clients/walrusMemoryClient.js';
import type { createLogger } from './utils/logger.js';

export type MemoryBackend = 'file' | 'walrus';
export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet';
export type LendingProtocol = 'suilend' | 'navi' | 'scallop';
export type PositionActionKind = 'supply' | 'withdraw' | 'borrow' | 'repay';

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
    actionCooldownMs: number;
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
  sui: {
    enabled: boolean;
    enablePositionCreation: boolean;
    enableBorrow: boolean;
    rpcUrl: string;
    network: SuiNetwork;
    privateKey: string;
    walletAddress: string;
    usdcCoinType: string;
    suiCoinType: string;
    allowedAssets: string[];
    allowedPools: string[];
    minIdleRaw: bigint;
    maxSupplyRaw: bigint;
    maxBorrowRaw: bigint;
    minHealthFactor: number;
    explorerBaseUrl: string;
    defaultAssets: {
      usdc: string;
      sui: string;
    };
    protocols: {
      suilend: { enabled: boolean };
      navi: { enabled: boolean };
      scallop: { enabled: boolean };
    };
  };
  walrus: {
    memoryBackend: MemoryBackend;
    publisherUrl: string;
    aggregatorUrl: string;
    epochs: number;
    stateBlobId: string;
    memwal: {
      enabled: boolean;
      accountId: string;
      delegateKey: string;
      relayerUrl: string;
      namespace: string;
    };
  };
}

export interface Clients {
  social: MoltxSocialClient;
  swap: MoltxSwapClient;
  suiExecution: SuiExecutionClient;
  suilend: SuilendClient;
  navi: NaviClient;
  scallop: ScallopClient;
  openai: OpenAIResponsesClient;
  x: XClient;
  walrusBlob: WalrusBlobClient;
  walrusMemory: WalrusMemoryClient;
}

export type NetworkName = 'ethereum' | 'arbitrum' | 'base' | 'polygon' | 'plasma';

export interface SuiTokenBalance {
  symbol: string;
  coinType: string;
  decimals: number;
  raw: string;
  formatted: string;
}

export interface SuiBalancesResponse {
  wallet: string;
  sui: SuiTokenBalance;
  usdc: SuiTokenBalance;
}

export interface SuilendMarket {
  coinType: string;
  symbol: string;
  decimals: number;
  supplyApr: number;
  borrowApr: number;
  totalApr: number;
  price: number;
  allowed: boolean;
}

export interface SuilendMarketsResponse {
  markets: SuilendMarket[];
}

export interface SuilendPosition {
  coinType: string;
  symbol: string;
  amount: string;
  amountUsd: number;
  side: 'deposit' | 'borrow';
}

export interface SuilendObligationResponse {
  obligationId: string | null;
  obligationOwnerCapId: string | null;
  healthFactor: number;
  borrowLimitUsd: number;
  weightedBorrowsUsd: number;
  depositedAmountUsd: number;
  borrowedAmountUsd: number;
  deposits: SuilendPosition[];
  borrows: SuilendPosition[];
}

export interface LendingRateRow {
  asset: string;
  coinType: string;
  suilend?: { supplyApr: number; borrowApr: number };
  navi?: { supplyApr: number; borrowApr: number };
  scallop?: { supplyApr: number; borrowApr: number };
}

export interface LendingRatesComparisonResponse {
  rows: LendingRateRow[];
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
  | { type: 'SUILEND_SUPPLY'; details?: Record<string, unknown> }
  | { type: 'SUILEND_WITHDRAW'; details?: Record<string, unknown> }
  | { type: 'SUILEND_BORROW'; details?: Record<string, unknown> }
  | { type: 'SUILEND_REPAY'; details?: Record<string, unknown> };

export interface ExecuteTransactionResult {
  digest: string;
  success: boolean;
}
