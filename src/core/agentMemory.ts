import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, LendingProtocol, PositionActionKind } from '../types.js';

export type ActionStatus = 'planned' | 'submitted' | 'confirmed' | 'failed';
export type TweetStatus = 'planned' | 'posted' | 'failed';
export type PendingTaskType = 'tweet_action' | 'retry_action' | 'health_alert';

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
    positionActions: AgentPositionActionRecord[];
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
  lastAction: AgentPositionActionRecord | null;
  recentActions: AgentPositionActionRecord[];
  recentRuns: AgentRunRecord[];
  snapshots: AgentSnapshots;
  actionSkipReason: string | null;
  healthAlertPending: AgentPendingTask | null;
  recentArtifacts: AgentArtifactRecord[];
}

export interface RecordPositionActionInput {
  runId: string;
  protocol: LendingProtocol;
  action: PositionActionKind;
  asset: string;
  rawAmount: string;
  obligationId?: string;
  status: ActionStatus;
  digest?: string;
  dryRun: boolean;
}

export interface RecordTweetInput {
  actionId?: string;
  status: TweetStatus;
  text?: string;
  externalId?: string;
}

const MAX_RUNS = 50;
const MAX_ACTIONS = 100;
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
    actions: { positionActions: [], tweets: [] },
    snapshots: {},
    pending: [],
    artifacts: []
  };
}

type LegacyState = Omit<Partial<AgentStateV1>, 'actions' | 'pending'> & {
  actions?: {
    positionActions?: AgentPositionActionRecord[];
    tweets?: AgentTweetRecord[];
  };
  pending?: Array<{
    type: string;
    actionId?: string;
    depositId?: string;
    createdAt: string;
    obligationId?: string;
    healthFactor?: number;
    suggestedAction?: 'repay' | 'supply';
  }>;
};

export function normalizeAgentState(config: AppConfig, parsed: LegacyState): AgentStateV1 | null {
  if (parsed.version !== 1) {
    return null;
  }

  const wallet = config.agent.walletAddress.toLowerCase();
  if (parsed.walletAddress && parsed.walletAddress.toLowerCase() !== wallet) {
    return null;
  }

  const positionActions = parsed.actions?.positionActions ?? [];

  const pending: AgentPendingTask[] = (parsed.pending ?? []).map((task) => {
    if (task.type === 'tweet_deposit') {
      return {
        type: 'tweet_action' as const,
        actionId: task.depositId ?? task.actionId,
        createdAt: task.createdAt
      };
    }

    if (task.type === 'retry_deposit') {
      return {
        type: 'retry_action' as const,
        actionId: task.depositId ?? task.actionId,
        createdAt: task.createdAt
      };
    }

    return task as AgentPendingTask;
  });

  const tweets = (parsed.actions?.tweets ?? []).map((tweet) => ({
    ...tweet,
    actionId: tweet.actionId ?? (tweet as { depositId?: string }).depositId
  }));

  return {
    version: 1,
    agentName: parsed.agentName ?? config.agent.name,
    walletAddress: wallet,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    runs: parsed.runs ?? [],
    actions: {
      positionActions,
      tweets
    },
    snapshots: parsed.snapshots ?? {},
    pending,
    artifacts: parsed.artifacts ?? []
  };
}

export function loadAgentState(config: AppConfig, statePath = resolveAgentStatePath(config)): AgentStateV1 {
  if (!fs.existsSync(statePath)) {
    return createEmptyAgentState(config);
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw) as LegacyState;
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

export function recordPositionAction(
  state: AgentStateV1,
  input: RecordPositionActionInput
): AgentPositionActionRecord {
  const id =
    input.digest ??
    (input.dryRun
      ? `dry-run-${input.runId}-${input.action}-${input.asset.toLowerCase()}`
      : `${input.runId}-${input.action}-${input.asset.toLowerCase()}`);

  const existing = state.actions.positionActions.find((action) => action.id === id);
  const record: AgentPositionActionRecord = existing ?? {
    id,
    runId: input.runId,
    protocol: input.protocol,
    action: input.action,
    asset: input.asset,
    rawAmount: input.rawAmount,
    status: input.status,
    dryRun: input.dryRun,
    createdAt: new Date().toISOString(),
    tweeted: false
  };

  record.runId = input.runId;
  record.protocol = input.protocol;
  record.action = input.action;
  record.asset = input.asset;
  record.rawAmount = input.rawAmount;
  record.status = input.status;
  record.dryRun = input.dryRun;
  if (input.obligationId) {
    record.obligationId = input.obligationId;
  }
  if (input.digest) {
    record.digest = input.digest;
  }

  if (!existing) {
    state.actions.positionActions.unshift(record);
    state.actions.positionActions = state.actions.positionActions.slice(0, MAX_ACTIONS);
  }

  // Supply-blocking coupling (intentional, "as it was"): a confirmed live supply queues a
  // tweet_action, and shouldSkipWriteAction() then blocks any further supply until that tweet
  // posts (or X posting is disabled / the token is missing). This is a deadlock risk — if it
  // bites, ENABLE_X_POSTING=false skips posting but the pending task still blocks. To make
  // posting never block, decouple it (fire-and-forget) instead of queueing here.
  if (record.status === 'confirmed' && !record.dryRun && !record.tweeted && record.action === 'supply') {
    const alreadyPending = state.pending.some(
      (task) => task.type === 'tweet_action' && task.actionId === record.id
    );
    if (!alreadyPending) {
      state.pending.push({
        type: 'tweet_action',
        actionId: record.id,
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

  if (input.actionId) {
    record.actionId = input.actionId;
  }
  if (input.text) {
    record.text = input.text;
  }
  if (input.externalId) {
    record.externalId = input.externalId;
  }

  state.actions.tweets.unshift(record);
  state.actions.tweets = state.actions.tweets.slice(0, MAX_TWEETS);

  if (input.actionId && input.status === 'posted') {
    const action = state.actions.positionActions.find((entry) => entry.id === input.actionId);
    if (action) {
      action.tweeted = true;
      if (input.externalId) {
        action.tweetId = input.externalId;
      }
    }

    state.pending = state.pending.filter(
      (task) => !(task.type === 'tweet_action' && task.actionId === input.actionId)
    );
  }

  return record;
}

export function queueHealthAlert(
  state: AgentStateV1,
  input: Omit<AgentPendingTask, 'type' | 'createdAt'> & { type?: never }
): AgentPendingTask {
  state.pending = state.pending.filter((task) => task.type !== 'health_alert');
  const task: AgentPendingTask = {
    type: 'health_alert',
    createdAt: new Date().toISOString(),
    ...input
  };
  state.pending.push(task);
  return task;
}

export function clearHealthAlert(state: AgentStateV1): void {
  state.pending = state.pending.filter((task) => task.type !== 'health_alert');
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

export function getMemorySummary(
  state: AgentStateV1,
  config: AppConfig,
  currentRunId?: string
): AgentMemorySummary {
  const skip = shouldSkipWriteAction(state, config);
  return {
    walletAddress: state.walletAddress,
    ...(currentRunId !== undefined ? { currentRunId } : {}),
    pending: state.pending,
    lastAction: state.actions.positionActions[0] ?? null,
    recentActions: state.actions.positionActions.slice(0, 5),
    recentRuns: state.runs.slice(0, 3),
    snapshots: state.snapshots,
    actionSkipReason: skip.skip ? skip.reason : null,
    healthAlertPending: state.pending.find((task) => task.type === 'health_alert') ?? null,
    recentArtifacts: state.artifacts.slice(0, 5)
  };
}

export function shouldSkipWriteAction(
  state: AgentStateV1,
  config: AppConfig,
  asset?: string,
  action: PositionActionKind = 'supply'
): { skip: boolean; reason: string | null } {
  // Supply-blocking coupling (see recordPositionAction): a pending tweet_action blocks the next
  // supply until it posts. Deadlock risk; decouple posting to fire-and-forget to remove this gate.
  const pendingTweet = state.pending.find((task) => task.type === 'tweet_action');
  if (pendingTweet && action === 'supply') {
    return { skip: true, reason: 'Complete pending tweet_action before making another supply' };
  }

  if (!asset) {
    return { skip: false, reason: null };
  }

  const normalized = asset.toLowerCase();
  const cutoff = Date.now() - config.agent.actionCooldownMs;
  const recent = state.actions.positionActions.find((entry) => {
    if (entry.dryRun || entry.status !== 'confirmed') {
      return false;
    }

    if (entry.asset.toLowerCase() !== normalized || entry.action !== action) {
      return false;
    }

    return new Date(entry.createdAt).getTime() >= cutoff;
  });

  if (recent) {
    return {
      skip: true,
      reason: `Confirmed ${recent.action} on ${recent.asset} within action cooldown (${config.agent.actionCooldownMs}ms)`
    };
  }

  return { skip: false, reason: null };
}

export function updateSnapshots(state: AgentStateV1, partial: AgentSnapshots): void {
  state.snapshots = { ...state.snapshots, ...partial };
}
