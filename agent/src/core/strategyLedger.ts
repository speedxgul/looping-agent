import fs from 'node:fs';
import path from 'node:path';
import type { StoredBlob, WalrusBlobClient } from '../clients/storage/walrusBlobClient.js';
import type { AppConfig, LendingProtocol, Logger, StrategyExecutionActor, SubagentRole } from '../types.js';

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

export interface StrategyLedgerStoreOptions {
  config: AppConfig;
  logger: Logger;
  ledgerPath?: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
}

const SUBAGENT_ROLES: SubagentRole[] = [
  'coordinator',
  'rate-scout',
  'position-risk',
  'loop-strategist',
  'executor',
  'unwind-guard'
];

const MAX_SNAPSHOTS = 50;
const MAX_PROPOSALS = 100;
const MAX_PLANS = 100;
const MAX_RECEIPTS = 100;
const MAX_LOCKS = 100;
const MAX_ARCHIVES = 100;

export class StrategyLedgerStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLockMs: number;

  constructor(private readonly options: StrategyLedgerStoreOptions) {
    this.ledgerPath = resolveStrategyLedgerPath(options.config, options.ledgerPath);
    this.lockPath = `${this.ledgerPath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
    this.staleLockMs = options.staleLockMs ?? 120000;
  }

  get path(): string {
    return this.ledgerPath;
  }

  load(): StrategyLedgerV1 {
    if (!fs.existsSync(this.ledgerPath)) {
      return createEmptyStrategyLedger(this.options.config);
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as Partial<StrategyLedgerV1>;
      return (
        normalizeStrategyLedger(this.options.config, parsed) ?? createEmptyStrategyLedger(this.options.config)
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn('Failed to load strategy ledger; using empty ledger', { error: message });
      return createEmptyStrategyLedger(this.options.config);
    }
  }

  save(ledger: StrategyLedgerV1): void {
    saveStrategyLedger(this.ledgerPath, ledger);
  }

  async update(mutator: (ledger: StrategyLedgerV1) => void | Promise<void>): Promise<StrategyLedgerV1> {
    await this.withLock(async () => {
      const ledger = this.load();
      await mutator(ledger);
      pruneLedger(ledger);
      this.save(ledger);
    });
    return this.load();
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let handle: number | null = null;

    while (handle === null) {
      try {
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
        handle = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error: unknown) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
        if (this.clearStaleLock()) {
          continue;
        }
        if (Date.now() - started > this.lockTimeoutMs) {
          throw new Error(`Timed out waiting for strategy ledger lock at ${this.lockPath}`);
        }
        await sleep(this.lockRetryMs);
      }
    }

    try {
      return await fn();
    } finally {
      fs.closeSync(handle);
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // Best-effort cleanup; a later timeout makes the stale lock visible.
      }
    }
  }

  private clearStaleLock(): boolean {
    const metadata = this.readLockMetadata();
    if (!metadata) {
      return false;
    }

    const lockAgeMs = Date.now() - metadata.createdAtMs;
    const ownerIsAlive = metadata.pid !== null && isProcessAlive(metadata.pid);
    if (ownerIsAlive && lockAgeMs < this.staleLockMs) {
      return false;
    }

    if (ownerIsAlive && lockAgeMs < this.staleLockMs * 5) {
      return false;
    }

    try {
      fs.unlinkSync(this.lockPath);
      this.options.logger.warn('Removed stale strategy ledger lock', {
        lockPath: this.lockPath,
        pid: metadata.pid,
        ageMs: lockAgeMs
      });
      return true;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return true;
      }
      return false;
    }
  }

  private readLockMetadata(): { pid: number | null; createdAtMs: number } | null {
    try {
      const stat = fs.statSync(this.lockPath);
      let pid: number | null = null;
      let createdAtMs = stat.mtimeMs;
      try {
        const parsed = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as {
          pid?: unknown;
          createdAt?: unknown;
        };
        if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
          pid = parsed.pid;
        }
        if (typeof parsed.createdAt === 'string') {
          const parsedCreatedAt = Date.parse(parsed.createdAt);
          if (Number.isFinite(parsedCreatedAt)) {
            createdAtMs = parsedCreatedAt;
          }
        }
      } catch {
        // Fall back to stat metadata when the lock predates metadata writes or is truncated.
      }
      return { pid, createdAtMs };
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      return null;
    }
  }
}

export function resolveStrategyLedgerPath(
  config: AppConfig,
  configured = config.loopStrategy.ledgerPath
): string {
  const trimmed = configured.trim();
  if (trimmed) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  }

  return path.resolve(process.cwd(), 'data/strategy-ledger.json');
}

export function createEmptyStrategyLedger(config: AppConfig): StrategyLedgerV1 {
  const now = new Date().toISOString();
  const subagents = Object.fromEntries(
    SUBAGENT_ROLES.map((role) => [
      role,
      {
        role,
        enabled: true,
        heartbeatAt: now,
        status: 'idle' as const
      }
    ])
  ) as Record<SubagentRole, SubagentHeartbeat>;

  return {
    version: 1,
    walletAddress: config.agent.walletAddress.toLowerCase(),
    updatedAt: now,
    subagents,
    marketSnapshots: [],
    positionSnapshots: [],
    strategyProposals: [],
    acceptedPlans: [],
    executionReceipts: [],
    riskLocks: [],
    loopPositions: [],
    walrusArchives: []
  };
}

export function normalizeStrategyLedger(
  config: AppConfig,
  parsed: Partial<StrategyLedgerV1>
): StrategyLedgerV1 | null {
  if (parsed.version !== 1) {
    return null;
  }

  const empty = createEmptyStrategyLedger(config);
  return {
    ...empty,
    walletAddress: parsed.walletAddress?.toLowerCase() ?? empty.walletAddress,
    updatedAt: parsed.updatedAt ?? empty.updatedAt,
    subagents: {
      ...empty.subagents,
      ...(parsed.subagents ?? {})
    },
    marketSnapshots: parsed.marketSnapshots ?? [],
    positionSnapshots: parsed.positionSnapshots ?? [],
    strategyProposals: (parsed.strategyProposals ?? []).map((proposal) => ({
      ...proposal,
      proposalType: proposal.proposalType ?? 'open_loop',
      createdBy: proposal.createdBy ?? proposal.proposerRole,
      targetSupplyAsset: proposal.targetSupplyAsset ?? proposal.borrowAsset,
      netAprBps: proposal.netAprBps ?? proposal.projectedNetAprBps
    })),
    acceptedPlans: parsed.acceptedPlans ?? [],
    executionReceipts: parsed.executionReceipts ?? [],
    riskLocks: parsed.riskLocks ?? [],
    loopPositions: parsed.loopPositions ?? [],
    walrusArchives: parsed.walrusArchives ?? []
  };
}

export function saveStrategyLedger(ledgerPath: string, ledger: StrategyLedgerV1): void {
  ledger.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const tempPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(ledger, null, 2));
  fs.renameSync(tempPath, ledgerPath);
}

export function recordHeartbeat(
  ledger: StrategyLedgerV1,
  role: SubagentRole,
  input: { runId?: string; status?: SubagentStatus; enabled?: boolean; message?: string } = {}
): void {
  ledger.subagents[role] = {
    role,
    enabled: input.enabled ?? true,
    heartbeatAt: new Date().toISOString(),
    status: input.status ?? 'ok',
    ...(input.runId ? { lastRunId: input.runId } : {}),
    ...(input.message ? { message: input.message } : {})
  };
}

export function staleSubagents(
  ledger: StrategyLedgerV1,
  staleMs: number,
  now = Date.now()
): SubagentHeartbeat[] {
  return Object.values(ledger.subagents).filter((heartbeat) => {
    if (!heartbeat.enabled) {
      return false;
    }
    return now - new Date(heartbeat.heartbeatAt).getTime() > staleMs;
  });
}

export function activeRiskLocks(ledger: StrategyLedgerV1): RiskLock[] {
  return ledger.riskLocks.filter((lock) => lock.active);
}

export function activeLoopOpeningPlans(ledger: StrategyLedgerV1): AcceptedPlan[] {
  return ledger.acceptedPlans.filter((plan) => plan.status === 'accepted' || plan.status === 'executing');
}

export function latestMarketSnapshot(ledger: StrategyLedgerV1): MarketSnapshot | null {
  return ledger.marketSnapshots[0] ?? null;
}

export function latestPositionSnapshot(ledger: StrategyLedgerV1): PositionSnapshot | null {
  return ledger.positionSnapshots[0] ?? null;
}

export function isFresh(iso: string | undefined, staleMs: number, now = Date.now()): boolean {
  if (!iso) {
    return false;
  }
  return now - new Date(iso).getTime() <= staleMs;
}

export function appendWalrusArchive(
  ledger: StrategyLedgerV1,
  kind: WalrusLedgerArchive['kind'],
  recordId: string,
  stored: StoredBlob
): void {
  ledger.walrusArchives.unshift({
    kind,
    recordId,
    blobId: stored.blobId,
    url: stored.url,
    createdAt: new Date().toISOString()
  });
}

export async function archiveLedgerRecord(
  ledger: StrategyLedgerV1,
  blobClient: WalrusBlobClient,
  logger: Logger,
  kind: WalrusLedgerArchive['kind'],
  recordId: string,
  value: unknown
): Promise<void> {
  try {
    const stored = await blobClient.storeString(JSON.stringify(value, null, 2));
    appendWalrusArchive(ledger, kind, recordId, stored);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to archive strategy ledger record to Walrus', { kind, recordId, error: message });
  }
}

function pruneLedger(ledger: StrategyLedgerV1): void {
  ledger.marketSnapshots = ledger.marketSnapshots.slice(0, MAX_SNAPSHOTS);
  ledger.positionSnapshots = ledger.positionSnapshots.slice(0, MAX_SNAPSHOTS);
  ledger.strategyProposals = ledger.strategyProposals.slice(0, MAX_PROPOSALS);
  ledger.acceptedPlans = ledger.acceptedPlans.slice(0, MAX_PLANS);
  ledger.executionReceipts = ledger.executionReceipts.slice(0, MAX_RECEIPTS);
  ledger.riskLocks = ledger.riskLocks.slice(0, MAX_LOCKS);
  ledger.walrusArchives = ledger.walrusArchives.slice(0, MAX_ARCHIVES);
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EINVAL')
    ) {
      return false;
    }
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
