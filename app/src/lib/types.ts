// Types mirrored from the agent package
// (agent/src/core/strategyLedger.ts and agent/src/core/agentMemory.ts).
// Kept as a standalone copy so the console has no build-time dependency on the
// agent workspace.

export type LendingProtocol = 'suilend' | 'navi' | 'scallop';

export type SubagentRole =
  | 'coordinator'
  | 'rate-scout'
  | 'position-risk'
  | 'loop-strategist'
  | 'executor'
  | 'unwind-guard';

export const SUBAGENT_ROLES: SubagentRole[] = [
  'coordinator',
  'rate-scout',
  'position-risk',
  'loop-strategist',
  'executor',
  'unwind-guard'
];

export type StrategyExecutionActor = SubagentRole | 'main-agent';

export type SubagentStatus = 'idle' | 'running' | 'ok' | 'error' | 'disabled';
export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'expired';
export type PlanStatus = 'accepted' | 'executing' | 'executed' | 'failed' | 'cancelled';
export type RiskLockSeverity = 'warning' | 'critical';
export type LoopPositionStatus = 'opening' | 'active' | 'unwinding' | 'closed';
export type StrategyProposalType = 'open_loop' | 'borrow_against_existing_collateral';

export interface SubagentHeartbeat {
  role: SubagentRole;
  enabled: boolean;
  heartbeatAt: string;
  lastRunId?: string;
  status: SubagentStatus;
  message?: string;
}

export interface MarketRate {
  protocol: LendingProtocol;
  asset: string;
  coinType: string;
  supplyApr: number;
  borrowApr: number;
  priceUsd: number;
  liquidityUsd?: number;
}

export interface MarketSnapshot {
  id: string;
  runId: string;
  capturedAt: string;
  rates: MarketRate[];
}

export interface PositionLeg {
  protocol: LendingProtocol;
  asset: string;
  coinType: string;
  rawAmount: string;
  amountUsd: number;
  side: 'deposit' | 'borrow';
}

export interface ProtocolPositionSnapshot {
  protocol: LendingProtocol;
  healthFactor: number;
  borrowLimitUsd: number;
  weightedBorrowsUsd: number;
  depositedAmountUsd: number;
  borrowedAmountUsd: number;
  obligationId?: string | null;
  obligationOwnerCapId?: string | null;
  obligationKeyId?: string | null;
  deposits: PositionLeg[];
  borrows: PositionLeg[];
}

export interface PositionSnapshot {
  id: string;
  runId: string;
  walletAddress: string;
  capturedAt: string;
  protocols: ProtocolPositionSnapshot[];
}

export interface LoopStrategyProposal {
  id: string;
  runId: string;
  proposerRole: SubagentRole;
  proposalType: StrategyProposalType;
  createdBy?: StrategyExecutionActor;
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  collateralAsset: 'USDC';
  borrowAsset: 'SUI';
  collateralProtocol: LendingProtocol;
  borrowProtocol: LendingProtocol;
  supplyTargetProtocol: LendingProtocol;
  rawCollateralAmount: string;
  rawBorrowAmount: string;
  collateralUsd: number;
  borrowUsd: number;
  projectedHealthFactor: number;
  projectedNetAprBps: number;
  unwindPath: string[];
  marketSnapshotId: string;
  positionSnapshotId: string;
  sourcePositionId?: string;
  targetSupplyAsset?: 'SUI';
  netAprBps?: number;
  rationale?: string;
  rejectionReason?: string;
}

export interface PolicyResult {
  allowed: boolean;
  reason: string;
  checkedAt: string;
}

export interface AcceptedPlan {
  id: string;
  proposalId: string;
  acceptedAt: string;
  status: PlanStatus;
  policy: PolicyResult;
  executorRunId?: string;
  claimedBy?: StrategyExecutionActor;
  claimedAt?: string;
  claimExpiresAt?: string;
  executionFingerprint?: string;
  executionReceiptId?: string;
  failureReason?: string;
}

export interface ExecutionLegReceipt {
  protocol: LendingProtocol;
  action: 'supply' | 'borrow' | 'repay' | 'withdraw';
  asset: string;
  rawAmount: string;
  status: 'planned' | 'submitted' | 'confirmed' | 'failed';
  digest?: string;
}

export interface ExecutionReceipt {
  id: string;
  planId: string;
  proposalId: string;
  executorRunId: string;
  executedBy?: StrategyExecutionActor;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  status: 'planned' | 'confirmed' | 'failed';
  legs: ExecutionLegReceipt[];
  beforeHealthFactor?: number;
  afterHealthFactor?: number;
  walrusReportBlobId?: string;
  error?: string;
}

export interface RiskLock {
  id: string;
  createdAt: string;
  role: SubagentRole;
  severity: RiskLockSeverity;
  reason: string;
  active: boolean;
  protocol?: LendingProtocol;
  healthFactor?: number;
  clearedAt?: string;
}

export interface LoopPosition {
  id: string;
  planId: string;
  proposalId: string;
  openedAt: string;
  status: LoopPositionStatus;
  collateralProtocol: LendingProtocol;
  supplyTargetProtocol: LendingProtocol;
  collateralAsset: 'USDC';
  borrowAsset: 'SUI';
  rawCollateralAmount: string;
  rawBorrowAmount: string;
  borrowUsd: number;
  depth: 1;
  unwindStatus?: string;
}

export interface WalrusLedgerArchive {
  blobId: string;
  url: string;
  kind: 'accepted_plan' | 'execution_receipt' | 'risk_lock';
  recordId: string;
  createdAt: string;
}

export interface StrategyLedgerV1 {
  version: 1;
  walletAddress: string;
  updatedAt: string;
  subagents: Record<SubagentRole, SubagentHeartbeat>;
  marketSnapshots: MarketSnapshot[];
  positionSnapshots: PositionSnapshot[];
  strategyProposals: LoopStrategyProposal[];
  acceptedPlans: AcceptedPlan[];
  executionReceipts: ExecutionReceipt[];
  riskLocks: RiskLock[];
  loopPositions: LoopPosition[];
  walrusArchives: WalrusLedgerArchive[];
}

// --- Agent memory (agent-state.json) ---

export type ActionStatus = 'planned' | 'submitted' | 'confirmed' | 'failed';
export type TweetStatus = 'planned' | 'posted' | 'failed';
export type PendingTaskType = 'tweet_action' | 'retry_action' | 'health_alert';
export type PositionActionKind = 'supply' | 'withdraw' | 'borrow' | 'repay';
export type ArtifactKind = 'run_report' | 'state_snapshot';

export interface AgentRunRecord {
  runId: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
}

export interface AgentPositionActionRecord {
  id: string;
  runId: string;
  protocol: LendingProtocol;
  action: PositionActionKind;
  asset: string;
  rawAmount: string;
  obligationId?: string;
  digest?: string;
  status: ActionStatus;
  dryRun: boolean;
  createdAt: string;
  tweeted: boolean;
  tweetId?: string;
}

export interface AgentTweetRecord {
  id: string;
  actionId?: string;
  status: TweetStatus;
  text?: string;
  externalId?: string;
  createdAt: string;
}

export interface AgentPendingTask {
  type: PendingTaskType;
  actionId?: string;
  obligationId?: string;
  healthFactor?: number;
  suggestedAction?: 'repay' | 'supply';
  createdAt: string;
}

export interface AgentSnapshots {
  lastSuilendObligation?: unknown;
  lastUsdcBalanceRaw?: string;
  lastTopMarketAsset?: string;
  lastHealthFactor?: number;
}

export interface AgentArtifactRecord {
  runId: string;
  kind: ArtifactKind;
  blobId: string;
  url: string;
  createdAt: string;
  description?: string;
}

export interface AgentStateV1 {
  version: 1;
  agentName: string;
  walletAddress: string;
  updatedAt: string;
  runs: AgentRunRecord[];
  actions: {
    positionActions: AgentPositionActionRecord[];
    tweets: AgentTweetRecord[];
  };
  snapshots: AgentSnapshots;
  pending: AgentPendingTask[];
  artifacts: AgentArtifactRecord[];
}
