import type { AppConfig, Clients, Logger } from '../types.js';
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

  const obligation = await clients.suilend.getObligation();
  if (obligation.borrows.length === 0) {
    clearHealthAlert(state);
    return { executed: false, reason: 'No active borrows' };
  }

  const guard = evaluateHealthGuard(obligation, config);
  if (!guard.critical) {
    clearHealthAlert(state);
    return { executed: false, reason: 'Health factor ok' };
  }

  const largestBorrow = [...obligation.borrows].sort((a, b) => b.amountUsd - a.amountUsd)[0];
  if (!largestBorrow || !obligation.obligationId) {
    queueHealthAlert(state, {
      obligationId: obligation.obligationId ?? undefined,
      healthFactor: obligation.healthFactor,
      suggestedAction: 'repay'
    });
    return { executed: false, reason: guard.reason ?? 'Critical health but no repay target' };
  }

  const repayAmount = largestBorrow.amount;
  const action = {
    type: 'SUILEND_REPAY' as const,
    details: {
      asset: largestBorrow.symbol.toLowerCase(),
      rawAmount: repayAmount,
      obligationId: obligation.obligationId
    }
  };

  const decision = evaluateActionPolicy(action, config);
  if (!decision.allowed && !config.runtime.dryRun) {
    queueHealthAlert(state, {
      obligationId: obligation.obligationId,
      healthFactor: obligation.healthFactor,
      suggestedAction: 'repay'
    });
    return { executed: false, reason: decision.reason };
  }

  if (config.runtime.dryRun) {
    recordPositionAction(state, {
      runId,
      protocol: 'suilend',
      action: 'repay',
      asset: largestBorrow.symbol,
      rawAmount: repayAmount,
      obligationId: obligation.obligationId,
      status: 'planned',
      dryRun: true
    });
    queueHealthAlert(state, {
      obligationId: obligation.obligationId,
      healthFactor: obligation.healthFactor,
      suggestedAction: 'repay'
    });
    await persist({ durable: false });
    logger.warn('Health guard would auto-repay in live mode', {
      healthFactor: obligation.healthFactor,
      asset: largestBorrow.symbol,
      rawAmount: repayAmount
    });
    return { executed: false, reason: 'Dry run: planned auto-repay' };
  }

  try {
    const result = await clients.suilend.executeRepay({
      coinType: largestBorrow.coinType,
      rawAmount: repayAmount,
      obligationId: obligation.obligationId
    });

    recordPositionAction(state, {
      runId,
      protocol: 'suilend',
      action: 'repay',
      asset: largestBorrow.symbol,
      rawAmount: repayAmount,
      obligationId: obligation.obligationId,
      status: 'confirmed',
      digest: result.digest,
      dryRun: false
    });
    clearHealthAlert(state);
    await persist({ durable: true });
    logger.info('Health guard auto-repay executed', {
      digest: result.digest,
      asset: largestBorrow.symbol,
      rawAmount: repayAmount
    });
    return { executed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    queueHealthAlert(state, {
      obligationId: obligation.obligationId,
      healthFactor: obligation.healthFactor,
      suggestedAction: 'repay'
    });
    await persist({ durable: false });
    logger.warn('Health guard auto-repay failed', { error: message });
    return { executed: false, reason: message };
  }
}
