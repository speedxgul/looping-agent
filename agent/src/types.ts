import type { NaviClient } from './clients/chain/naviClient.js';
import type { ScallopClient } from './clients/chain/scallopClient.js';
import type { SuiExecutionClient } from './clients/chain/suiExecutionClient.js';
import type { SuilendClient } from './clients/chain/suilendClient.js';
import type { OpenAIResponsesClient } from './clients/http/openaiResponsesClient.js';
import type { XClient } from './clients/http/xClient.js';
import type { WalrusBlobClient } from './clients/storage/walrusBlobClient.js';
import type { WalrusMemoryClient } from './clients/storage/walrusMemoryClient.js';
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
  x: {
    enablePosting: boolean;
    userAccessToken: string;
    apiBase: string;
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
  suiExecution: SuiExecutionClient;
  suilend: SuilendClient;
  navi: NaviClient;
  scallop: ScallopClient;
  openai: OpenAIResponsesClient;
  x: XClient;
  walrusBlob: WalrusBlobClient;
  walrusMemory: WalrusMemoryClient;
}

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
  | { type: 'SUILEND_SUPPLY'; details?: Record<string, unknown> }
  | { type: 'SUILEND_WITHDRAW'; details?: Record<string, unknown> }
  | { type: 'SUILEND_BORROW'; details?: Record<string, unknown> }
  | { type: 'SUILEND_REPAY'; details?: Record<string, unknown> };

export interface ExecuteTransactionResult {
  digest: string;
  success: boolean;
}
