import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../types.js';

export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export type DepositStatus = 'planned' | 'submitted' | 'confirmed' | 'failed';
export type TweetStatus = 'planned' | 'posted' | 'failed';
export type PendingTaskType = 'tweet_deposit' | 'retry_deposit';

export interface AgentRunRecord {
  runId: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
}

export interface AgentDepositRecord {
  id: string;
  runId: string;
  fToken: string;
  symbol?: string;
  rawAmount: string;
  underlying?: string;
  status: DepositStatus;
  txHash?: string;
  dryRun: boolean;
  createdAt: string;
  tweeted: boolean;
  tweetId?: string;
}

export interface AgentTweetRecord {
  id: string;
  depositId?: string;
  status: TweetStatus;
  text?: string;
  externalId?: string;
  createdAt: string;
}

export interface AgentPendingTask {
  type: PendingTaskType;
  depositId: string;
  createdAt: string;
}

export interface AgentSnapshots {
  lastFluidPositions?: unknown;
  lastUsdcBalanceRaw?: string;
  lastTopMarketSymbol?: string;
  lastTopMarketFToken?: string;
}

export type ArtifactKind = 'run_report' | 'state_snapshot';

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
    deposits: AgentDepositRecord[];
    tweets: AgentTweetRecord[];
  };
  snapshots: AgentSnapshots;
  pending: AgentPendingTask[];
  artifacts: AgentArtifactRecord[];
}

export interface AgentMemorySummary {
  walletAddress: string;
  currentRunId?: string;
  pending: AgentPendingTask[];
  lastDeposit: AgentDepositRecord | null;
  recentDeposits: AgentDepositRecord[];
  recentRuns: AgentRunRecord[];
  snapshots: AgentSnapshots;
  depositSkipReason: string | null;
  recentArtifacts: AgentArtifactRecord[];
}

export interface RecordDepositInput {
  runId: string;
  fToken: string;
  rawAmount: string;
  symbol?: string;
  underlying?: string;
  status: DepositStatus;
  txHash?: string;
  dryRun: boolean;
}

export interface RecordTweetInput {
  depositId?: string;
  status: TweetStatus;
  text?: string;
  externalId?: string;
}

const MAX_RUNS = 50;
const MAX_DEPOSITS = 100;
const MAX_TWEETS = 50;
const MAX_ARTIFACTS = 50;
const SUMMARY_MAX_LENGTH = 2000;

export function resolveAgentStatePath(config: AppConfig): string {
  const configured = config.agent.statePath.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  return path.resolve(process.cwd(), 'data/agent-state.json');
}

export function createEmptyAgentState(config: AppConfig): AgentStateV1 {
  return {
    version: 1,
    agentName: config.agent.name,
    walletAddress: config.agent.walletAddress.toLowerCase(),
    updatedAt: new Date().toISOString(),
    runs: [],
    actions: { deposits: [], tweets: [] },
    snapshots: {},
    pending: [],
    artifacts: []
  };
}

/**
 * Validate and normalize a parsed state object (from any backend). Returns null
 * when the payload is incompatible (wrong version, or a different wallet) so the
 * caller can reset to an empty state.
 */
export function normalizeAgentState(config: AppConfig, parsed: Partial<AgentStateV1>): AgentStateV1 | null {
  if (parsed.version !== 1) {
    return null;
  }

  const wallet = config.agent.walletAddress.toLowerCase();
  if (parsed.walletAddress && parsed.walletAddress !== wallet) {
    return null;
  }

  return {
    version: 1,
    agentName: parsed.agentName ?? config.agent.name,
    walletAddress: wallet,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    runs: parsed.runs ?? [],
    actions: {
      deposits: parsed.actions?.deposits ?? [],
      tweets: parsed.actions?.tweets ?? []
    },
    snapshots: parsed.snapshots ?? {},
    pending: parsed.pending ?? [],
    artifacts: parsed.artifacts ?? []
  };
}

export function loadAgentState(config: AppConfig, statePath = resolveAgentStatePath(config)): AgentStateV1 {
  if (!fs.existsSync(statePath)) {
    return createEmptyAgentState(config);
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AgentStateV1>;
  return normalizeAgentState(config, parsed) ?? createEmptyAgentState(config);
}

export function saveAgentState(statePath: string, state: AgentStateV1): void {
  state.updatedAt = new Date().toISOString();
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, statePath);
}

export function beginRun(state: AgentStateV1): string {
  const runId = new Date().toISOString();
  state.runs.unshift({
    runId,
    startedAt: runId
  });
  state.runs = state.runs.slice(0, MAX_RUNS);
  return runId;
}

export function endRun(state: AgentStateV1, runId: string, summary?: string): void {
  const run = state.runs.find((entry) => entry.runId === runId);
  if (!run) {
    return;
  }

  run.endedAt = new Date().toISOString();
  if (summary) {
    run.summary = summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH)}…` : summary;
  }
}

export function recordDeposit(state: AgentStateV1, input: RecordDepositInput): AgentDepositRecord {
  const id =
    input.txHash ??
    (input.dryRun ? `dry-run-${input.runId}-${input.fToken.toLowerCase()}` : `${input.runId}-${input.fToken.toLowerCase()}`);

  const existing = state.actions.deposits.find((deposit) => deposit.id === id);
  const record: AgentDepositRecord = existing ?? {
    id,
    runId: input.runId,
    fToken: input.fToken,
    rawAmount: input.rawAmount,
    status: input.status,
    dryRun: input.dryRun,
    createdAt: new Date().toISOString(),
    tweeted: false
  };

  record.runId = input.runId;
  record.fToken = input.fToken;
  record.rawAmount = input.rawAmount;
  record.status = input.status;
  record.dryRun = input.dryRun;
  if (input.symbol) {
    record.symbol = input.symbol;
  }
  if (input.underlying) {
    record.underlying = input.underlying;
  }
  if (input.txHash) {
    record.txHash = input.txHash;
  }

  if (!existing) {
    state.actions.deposits.unshift(record);
    state.actions.deposits = state.actions.deposits.slice(0, MAX_DEPOSITS);
  }

  if (record.status === 'confirmed' && !record.dryRun && !record.tweeted) {
    const alreadyPending = state.pending.some(
      (task) => task.type === 'tweet_deposit' && task.depositId === record.id
    );
    if (!alreadyPending) {
      state.pending.push({
        type: 'tweet_deposit',
        depositId: record.id,
        createdAt: new Date().toISOString()
      });
    }
  }

  return record;
}

export function recordTweet(state: AgentStateV1, input: RecordTweetInput): AgentTweetRecord {
  const record: AgentTweetRecord = {
    id: input.externalId ?? `tweet-${Date.now()}`,
    status: input.status,
    createdAt: new Date().toISOString()
  };

  if (input.depositId) {
    record.depositId = input.depositId;
  }
  if (input.text) {
    record.text = input.text;
  }
  if (input.externalId) {
    record.externalId = input.externalId;
  }

  state.actions.tweets.unshift(record);
  state.actions.tweets = state.actions.tweets.slice(0, MAX_TWEETS);

  if (input.depositId && input.status === 'posted') {
    const deposit = state.actions.deposits.find((entry) => entry.id === input.depositId);
    if (deposit) {
      deposit.tweeted = true;
      if (input.externalId) {
        deposit.tweetId = input.externalId;
      }
    }

    state.pending = state.pending.filter(
      (task) => !(task.type === 'tweet_deposit' && task.depositId === input.depositId)
    );
  }

  return record;
}

export function recordArtifact(
  state: AgentStateV1,
  input: Omit<AgentArtifactRecord, 'createdAt'>
): AgentArtifactRecord {
  const record: AgentArtifactRecord = {
    ...input,
    createdAt: new Date().toISOString()
  };

  state.artifacts.unshift(record);
  state.artifacts = state.artifacts.slice(0, MAX_ARTIFACTS);
  return record;
}

export function getMemorySummary(state: AgentStateV1, config: AppConfig, currentRunId?: string): AgentMemorySummary {
  const skip = shouldSkipDeposit(state, config);
  return {
    walletAddress: state.walletAddress,
    currentRunId,
    pending: state.pending,
    lastDeposit: state.actions.deposits[0] ?? null,
    recentDeposits: state.actions.deposits.slice(0, 5),
    recentRuns: state.runs.slice(0, 3),
    snapshots: state.snapshots,
    depositSkipReason: skip.skip ? skip.reason : null,
    recentArtifacts: state.artifacts.slice(0, 5)
  };
}

export function shouldSkipDeposit(
  state: AgentStateV1,
  config: AppConfig,
  fTokenAddress?: string
): { skip: boolean; reason: string | null } {
  const pendingTweet = state.pending.find((task) => task.type === 'tweet_deposit');
  if (pendingTweet) {
    return { skip: true, reason: 'Complete pending tweet_deposit before making another deposit' };
  }

  if (!fTokenAddress) {
    return { skip: false, reason: null };
  }

  const normalized = fTokenAddress.toLowerCase();
  const cutoff = Date.now() - config.agent.depositCooldownMs;
  const recent = state.actions.deposits.find((deposit) => {
    if (deposit.dryRun || deposit.status !== 'confirmed') {
      return false;
    }

    if (deposit.fToken.toLowerCase() !== normalized) {
      return false;
    }

    return new Date(deposit.createdAt).getTime() >= cutoff;
  });

  if (recent) {
    return {
      skip: true,
      reason: `Confirmed deposit to ${recent.fToken} within deposit cooldown (${config.agent.depositCooldownMs}ms)`
    };
  }

  return { skip: false, reason: null };
}

export function updateSnapshots(state: AgentStateV1, partial: AgentSnapshots): void {
  state.snapshots = { ...state.snapshots, ...partial };
}
