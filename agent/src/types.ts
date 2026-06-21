import type { NaviClient } from './clients/chain/naviClient.js';
import type { ScallopClient } from './clients/chain/scallopClient.js';
import type { SuiExecutionClient } from './clients/chain/suiExecutionClient.js';
import type { SuilendClient } from './clients/chain/suilendClient.js';
import type { TreasuryClient } from './clients/chain/treasuryClient.js';
/** The LLM client the agent loop drives — satisfied by both the OpenAI (Responses) and the
 *  Anthropic (Messages) backed clients. */
export interface LlmClient {
  create(params: {
    instructions: string;
    input: OpenAIInputItem[];
    tools: OpenAIToolDefinition[];
  }): Promise<OpenAIResponse>;
}

import type { XClient } from './clients/http/xClient.js';
import type { WalrusBlobClient } from './clients/storage/walrusBlobClient.js';
import type { WalrusMemoryClient } from './clients/storage/walrusMemoryClient.js';
import type { ReserveCurve } from './core/allocation.js';
import type { createLogger } from './utils/logger.js';

export type MemoryBackend = 'file' | 'walrus';
export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet';
export type LendingProtocol = 'suilend' | 'navi' | 'scallop';
export type PositionActionKind = 'supply' | 'withdraw' | 'borrow' | 'repay';
export type SubagentRole =
  | 'coordinator'
  | 'rate-scout'
  | 'position-risk'
  | 'loop-strategist'
  | 'executor'
  | 'unwind-guard';
export type StrategyExecutionActor = SubagentRole | 'main-agent';

export type Logger = ReturnType<typeof createLogger>;

export interface AppConfig {
  runtime: {
    dryRun: boolean;
    nodeEnv: string;
    autonomyIntervalMs: number;
    subagentIntervalsMs?: Record<SubagentRole, number>;
    supervisorRoles?: Array<SubagentRole | 'main'>;
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
  /** Optional Anthropic backend — when apiKey is set, the agent's LLM client uses Anthropic's
   *  Messages API instead of OpenAI's Responses API (same tool loop). */
  anthropic: {
    apiKey: string;
    model: string;
    baseUrl: string;
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
    /** Protocols the agent may write to (supply/withdraw/borrow/repay). */
    allowedProtocols: LendingProtocol[];
    /** Min supply-APR improvement (basis points) before moving existing funds. */
    rebalanceMinAprDeltaBps: number;
    defaultAssets: {
      usdc: string;
      sui: string;
    };
    protocols: {
      // `enabled` gates reads; `write` gates supply/withdraw/borrow/repay.
      suilend: { enabled: boolean; write: boolean };
      navi: { enabled: boolean; write: boolean };
      scallop: { enabled: boolean; write: boolean };
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
  /**
   * Non-custodial treasury mode. When `enabled`, the agent acts only as Submitter:
   * funds live in the on-chain `Treasury`, the enclave decides + signs allocations, and
   * the agent relays them via the attested `verified_supply_*` path (instead of moving
   * its own wallet funds). Object ids come from `deployments/<network>.env`.
   */
  treasury: {
    enabled: boolean;
    /** The protocol-free `treasury_core` package (decision + capability + enclave registration). */
    packageId: string;
    /** The `mock_adapter` package id (testnet/demo supply). */
    mockAdapterPackageId: string;
    treasuryId: string;
    agentCapId: string;
    /** Shared `DecisionRegistry` object id. */
    registryId: string;
    /** Shared attested `Enclave<DECISION>` object id. */
    enclaveId: string;
    enclaveUrl: string;
    /**
     * Per-protocol shared-object ids needed to submit a real (non-mock) leg. A protocol's
     * legs are only submittable once its ids are filled (otherwise the enclave still
     * decides them but treasury_supply reports them as skipped). Mainnet object ids.
     * `adapterPackageId` is the protocol's own adapter package (split architecture).
     */
    protocols: {
      suilend: {
        adapterPackageId: string;
        marketType: string;
        lendingMarketId: string;
        reserveArrayIndex: number;
        /** On-chain Pyth `PriceInfoObject` id for the asset; set → reserve refresh is
         *  prepended to the Suilend supply PTB (mainnet). Empty → no refresh. */
        pythPriceInfoObjectId: string;
      };
      scallop: { adapterPackageId: string; versionId: string; marketId: string };
      navi: {
        adapterPackageId: string;
        storageId: string;
        poolId: string;
        incentiveV2Id: string;
        incentiveV3Id: string;
        assetId: number;
      };
    };
  };
  loopStrategy: {
    ledgerPath: string;
    enabled: boolean;
    executionEnabled: boolean;
    collateralAsset: string;
    borrowAsset: string;
    maxDepth: number;
    minHealthFactor: number;
    criticalHealthFactor: number;
    maxBorrowUsd: number;
    maxCollateralUsd: number;
    minNetAprBps: number;
    proposalTtlMs: number;
    staleHeartbeatMs: number;
    staleSnapshotMs: number;
    useExistingCollateral: boolean;
    borrowCapacityFraction: number;
    executionClaimTtlMs: number;
    llmStrategistEnabled: boolean;
    mainAgentSupplyWhenLoopEnabled: boolean;
  };
}

export interface Clients {
  suiExecution: SuiExecutionClient;
  suilend: SuilendClient;
  navi: NaviClient;
  scallop: ScallopClient;
  /** Present only when treasury mode is enabled (non-custodial path). */
  treasury: TreasuryClient | null;
  openai: LlmClient;
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
  /**
   * Full reserve rate curve for the allocation solver (own-impact aware). Optional
   * so existing callers that only read spot APRs keep working; populated by each
   * protocol's getMarkets when the on-chain curve params are available.
   */
  curve?: ReserveCurve;
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

/** A generic lending market row. Suilend reserves already match this shape. */
export type LendingMarket = SuilendMarket;
export type LendingMarketsResponse = SuilendMarketsResponse;

/** A single supplied/borrowed leg of a position, normalized across protocols. */
export interface NormalizedPosition {
  coinType: string;
  symbol: string;
  amount: string;
  amountUsd: number;
  side: 'deposit' | 'borrow';
}

/**
 * A wallet's lending position on one protocol, normalized so the agent loop,
 * policy, and health guard can treat Suilend / NAVI / Scallop uniformly.
 * `obligation*` handles are protocol-specific and only populated where the
 * protocol's write PTBs need them (Suilend: obligation + ownerCap; Scallop:
 * obligation + key; NAVI: address-based, none).
 */
export interface NormalizedPositions {
  protocol: LendingProtocol;
  healthFactor: number;
  borrowLimitUsd: number;
  weightedBorrowsUsd: number;
  depositedAmountUsd: number;
  borrowedAmountUsd: number;
  deposits: NormalizedPosition[];
  borrows: NormalizedPosition[];
  obligationId?: string | null;
  obligationOwnerCapId?: string | null;
  obligationKeyId?: string | null;
}

export interface LendingWriteParams {
  coinType: string;
  asset: string;
  rawAmount: string;
  /** Pre-fetched positions (carry obligation handles); fetched lazily if omitted. */
  positions?: NormalizedPositions;
}

/**
 * Common surface every lending protocol client implements so the tool registry,
 * policy, and health guard route by protocol without protocol-specific branches.
 */
export interface LendingProtocolClient {
  readonly name: LendingProtocol;
  readonly enabled: boolean;
  /** True when a write needs an obligation object (Suilend, Scallop) vs address-based (NAVI). */
  readonly requiresObligationForWrite: boolean;
  resolveCoinType(asset: string): string;
  isAssetAllowed(coinType: string): boolean;
  getMarkets(): Promise<LendingMarketsResponse>;
  getPositions(owner?: string): Promise<NormalizedPositions>;
  executeSupply(params: LendingWriteParams): Promise<ExecuteTransactionResult>;
  executeWithdraw(params: LendingWriteParams): Promise<ExecuteTransactionResult>;
  executeBorrow(params: LendingWriteParams): Promise<ExecuteTransactionResult>;
  executeRepay(params: LendingWriteParams): Promise<ExecuteTransactionResult>;
  /**
   * Projected health factor if `borrowUsd` more were borrowed. Async because NAVI
   * and Scallop run on-chain/portfolio simulations; Suilend computes it locally.
   * Convention matches Suilend: HF = borrowLimitUsd / weightedBorrowsUsd, liquidation
   * risk as HF approaches 1, so the policy floor (SUI_MIN_HEALTH_FACTOR) is uniform.
   */
  simulateHealthFactorAfterBorrow(params: {
    coinType: string;
    rawAmount: string;
    borrowUsd: number;
    positions: NormalizedPositions;
  }): Promise<number>;
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

export type LendingActionType = 'LENDING_SUPPLY' | 'LENDING_WITHDRAW' | 'LENDING_BORROW' | 'LENDING_REPAY';

/** Maps a position action kind to its policy action type. */
export const LENDING_ACTION_TYPE: Record<PositionActionKind, LendingActionType> = {
  supply: 'LENDING_SUPPLY',
  withdraw: 'LENDING_WITHDRAW',
  borrow: 'LENDING_BORROW',
  repay: 'LENDING_REPAY'
};

export type AgentAction =
  | { type: 'OBSERVE'; summary: string; details?: Record<string, unknown> }
  | { type: LendingActionType; details?: Record<string, unknown> }
  // Deprecated Suilend-specific aliases — still accepted by policy for back-compat.
  | { type: 'SUILEND_SUPPLY'; details?: Record<string, unknown> }
  | { type: 'SUILEND_WITHDRAW'; details?: Record<string, unknown> }
  | { type: 'SUILEND_BORROW'; details?: Record<string, unknown> }
  | { type: 'SUILEND_REPAY'; details?: Record<string, unknown> };

export interface ExecuteTransactionResult {
  digest: string;
  success: boolean;
}
