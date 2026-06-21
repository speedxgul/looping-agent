import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentStateV1, StrategyLedgerV1, SubagentHeartbeat, SubagentRole } from './types';
import { SUBAGENT_ROLES } from './types';

/**
 * Directory that holds the agent's on-disk JSON state. Defaults to the sibling
 * `agent/data` folder in the repo; override with AGENT_DATA_DIR (absolute, or
 * relative to the app/ working directory).
 */
function dataDir(): string {
  const configured = process.env.AGENT_DATA_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), '..', 'agent', 'data');
}

async function readJsonFile<T>(fileName: string): Promise<T | null> {
  const filePath = path.join(dataDir(), fileName);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function emptySubagents(): Record<SubagentRole, SubagentHeartbeat> {
  const now = new Date(0).toISOString();
  return Object.fromEntries(
    SUBAGENT_ROLES.map((role) => [
      role,
      { role, enabled: false, heartbeatAt: now, status: 'disabled' as const }
    ])
  ) as Record<SubagentRole, SubagentHeartbeat>;
}

export function emptyLedger(): StrategyLedgerV1 {
  return {
    version: 1,
    walletAddress: '',
    updatedAt: new Date(0).toISOString(),
    subagents: emptySubagents(),
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

export function emptyMemory(): AgentStateV1 {
  return {
    version: 1,
    agentName: '',
    walletAddress: '',
    updatedAt: new Date(0).toISOString(),
    runs: [],
    actions: { positionActions: [], tweets: [] },
    snapshots: {},
    pending: [],
    artifacts: []
  };
}

export interface LoadResult<T> {
  data: T;
  ok: boolean;
}

export async function loadLedger(): Promise<LoadResult<StrategyLedgerV1>> {
  const parsed = await readJsonFile<StrategyLedgerV1>('strategy-ledger.json');
  if (!parsed) {
    return { data: emptyLedger(), ok: false };
  }
  return {
    data: {
      ...emptyLedger(),
      ...parsed,
      subagents: { ...emptySubagents(), ...(parsed.subagents ?? {}) }
    },
    ok: true
  };
}

export async function loadMemory(): Promise<LoadResult<AgentStateV1>> {
  const parsed = await readJsonFile<AgentStateV1>('agent-state.json');
  if (!parsed) {
    return { data: emptyMemory(), ok: false };
  }
  return {
    data: {
      ...emptyMemory(),
      ...parsed,
      actions: {
        positionActions: parsed.actions?.positionActions ?? [],
        tweets: parsed.actions?.tweets ?? []
      },
      snapshots: parsed.snapshots ?? {}
    },
    ok: true
  };
}
