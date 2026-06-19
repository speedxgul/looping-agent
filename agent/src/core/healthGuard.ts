import type {
  AppConfig,
  Clients,
  LendingProtocol,
  LendingProtocolClient,
  Logger,
  NormalizedPositions
} from '../types.js';
import {
  type AgentStateV1,
  clearHealthAlert,
  queueHealthAlert,
  recordPositionAction
} from './agentMemory.js';
import type { SaveOptions } from './memoryStore.js';
import { evaluateActionPolicy, evaluateHealthGuard } from './policy.js';

interface HealthGuardOptions {
  state: AgentStateV1;
  runId: string;
  clients: Clients;
  config: AppConfig;
  logger: Logger;
  persist: (opts?: SaveOptions) => Promise<void>;
}

const PROTOCOLS: LendingProtocol[] = ['suilend', 'navi', 'scallop'];

function protocolClient(clients: Clients, protocol: LendingProtocol): LendingProtocolClient {
  if (protocol === 'navi') return clients.navi;
  if (protocol === 'scallop') return clients.scallop;
  return clients.suilend;
}

/**
 * Pre-cycle safety pass: across every enabled protocol, if a borrow position's
 * health factor is below SUI_MIN_HEALTH_FACTOR, auto-repay its largest borrow (live)
 * or plan/queue the repay (dry-run or when blocked). Best-effort, protocol-agnostic.
 */
export async function runHealthGuard({
  state,
  runId,
  clients,
  config,
  logger,
  persist
}: HealthGuardOptions): Promise<{ executed: boolean; reason?: string }> {
  if (!config.sui.enabled) {
    return { executed: false, reason: 'Sui lending disabled' };
  }

  const protocols = PROTOCOLS.filter(
    (protocol) => config.sui.protocols[protocol]?.enabled && config.sui.allowedProtocols.includes(protocol)
  );

  let anyBorrows = false;
  let executed = false;
  const reasons: string[] = [];

  for (const protocol of protocols) {
    const client = protocolClient(clients, protocol);
    let positions: NormalizedPositions;
    try {
      positions = await client.getPositions(config.agent.walletAddress);
    } catch (error: unknown) {
      reasons.push(`${protocol}: positions read failed (${errorMessage(error)})`);
      continue;
    }

    if (positions.borrows.length === 0) {
      continue;
    }
    anyBorrows = true;

    const guard = evaluateHealthGuard(positions, config);
    if (!guard.critical) {
      reasons.push(`${protocol}: health ok`);
      continue;
    }

    const result = await repayCritical({
      protocol,
      client,
      positions,
      state,
      runId,
      config,
      logger,
      persist
    });
    executed = executed || result.executed;
    reasons.push(`${protocol}: ${result.reason}`);
  }

  if (!anyBorrows) {
    clearHealthAlert(state);
    return { executed: false, reason: 'No active borrows' };
  }

  return { executed, reason: reasons.join('; ') };
}

async function repayCritical(args: {
  protocol: LendingProtocol;
  client: LendingProtocolClient;
  positions: NormalizedPositions;
  state: AgentStateV1;
  runId: string;
  config: AppConfig;
  logger: Logger;
  persist: (opts?: SaveOptions) => Promise<void>;
}): Promise<{ executed: boolean; reason: string }> {
  const { protocol, client, positions, state, runId, config, logger, persist } = args;

  const largestBorrow = [...positions.borrows].sort((a, b) => b.amountUsd - a.amountUsd)[0];
  if (!largestBorrow) {
    queueHealthAlert(state, {
      obligationId: positions.obligationId ?? undefined,
      healthFactor: positions.healthFactor,
      suggestedAction: 'repay'
    });
    await persist({ durable: false });
    return { executed: false, reason: 'critical but no repay target' };
  }

  const asset = largestBorrow.symbol.toLowerCase();
  const rawAmount = largestBorrow.amount;
  const action = {
    type: 'LENDING_REPAY' as const,
    details: {
      protocol,
      asset,
      coinType: largestBorrow.coinType,
      rawAmount,
      obligationId: positions.obligationId
    }
  };

  const decision = evaluateActionPolicy(action, config);
  if (!decision.allowed && !config.runtime.dryRun) {
    queueHealthAlert(state, {
      obligationId: positions.obligationId ?? undefined,
      healthFactor: positions.healthFactor,
      suggestedAction: 'repay'
    });
    await persist({ durable: false });
    return { executed: false, reason: decision.reason };
  }

  if (config.runtime.dryRun) {
    recordPositionAction(state, {
      runId,
      protocol,
      action: 'repay',
      asset: largestBorrow.symbol,
      rawAmount,
      ...(positions.obligationId ? { obligationId: positions.obligationId } : {}),
      status: 'planned',
      dryRun: true
    });
    queueHealthAlert(state, {
      obligationId: positions.obligationId ?? undefined,
      healthFactor: positions.healthFactor,
      suggestedAction: 'repay'
    });
    await persist({ durable: false });
    logger.warn('Health guard would auto-repay in live mode', {
      protocol,
      healthFactor: positions.healthFactor,
      asset: largestBorrow.symbol,
      rawAmount
    });
    return { executed: false, reason: 'dry-run: planned auto-repay' };
  }

  try {
    const result = await client.executeRepay({
      coinType: largestBorrow.coinType,
      asset,
      rawAmount,
      positions
    });
    recordPositionAction(state, {
      runId,
      protocol,
      action: 'repay',
      asset: largestBorrow.symbol,
      rawAmount,
      ...(positions.obligationId ? { obligationId: positions.obligationId } : {}),
      status: 'confirmed',
      digest: result.digest,
      dryRun: false
    });
    clearHealthAlert(state);
    await persist({ durable: true });
    logger.info('Health guard auto-repay executed', {
      protocol,
      digest: result.digest,
      asset: largestBorrow.symbol,
      rawAmount
    });
    return { executed: true, reason: `auto-repaid (${result.digest})` };
  } catch (error: unknown) {
    const message = errorMessage(error);
    queueHealthAlert(state, {
      obligationId: positions.obligationId ?? undefined,
      healthFactor: positions.healthFactor,
      suggestedAction: 'repay'
    });
    await persist({ durable: false });
    logger.warn('Health guard auto-repay failed', { protocol, error: message });
    return { executed: false, reason: message };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
