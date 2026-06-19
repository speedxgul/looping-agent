import type { AgentAction, AppConfig, SuilendObligationResponse } from '../types.js';

export function evaluateActionPolicy(
  action: AgentAction,
  config: AppConfig
): { allowed: boolean; reason: string } {
  if (action.type === 'SUILEND_SUPPLY') {
    return evaluateSuilendWrite(action.details ?? {}, config, {
      requirePositionCreation: true,
      checkDryRun: true,
      maxAmount: config.sui.maxSupplyRaw,
      maxLabel: 'SUI_MAX_SUPPLY_AMOUNT_RAW'
    });
  }

  if (action.type === 'SUILEND_WITHDRAW') {
    return evaluateSuilendWrite(action.details ?? {}, config, {
      requirePositionCreation: false,
      checkDryRun: false,
      maxAmount: config.sui.maxSupplyRaw,
      maxLabel: 'SUI_MAX_SUPPLY_AMOUNT_RAW'
    });
  }

  if (action.type === 'SUILEND_BORROW') {
    if (!config.sui.enableBorrow) {
      return deny('Sui borrow is disabled');
    }

    const base = evaluateSuilendWrite(action.details ?? {}, config, {
      requirePositionCreation: false,
      checkDryRun: true,
      maxAmount: config.sui.maxBorrowRaw,
      maxLabel: 'SUI_MAX_BORROW_AMOUNT_RAW'
    });
    if (!base.allowed) {
      return base;
    }

    const projectedHealth = Number(action.details?.projectedHealthFactor ?? Number.POSITIVE_INFINITY);
    // Fail closed: an unparseable/NaN projected health factor must NOT pass the guard
    // (NaN < x is false, which would silently allow the borrow).
    if (!Number.isFinite(projectedHealth) || projectedHealth < config.sui.minHealthFactor) {
      return deny(
        `Borrow would push health factor below SUI_MIN_HEALTH_FACTOR (${config.sui.minHealthFactor})`
      );
    }

    return allow();
  }

  if (action.type === 'SUILEND_REPAY') {
    return evaluateSuilendWrite(action.details ?? {}, config, {
      requirePositionCreation: false,
      checkDryRun: true,
      maxAmount: config.sui.maxBorrowRaw,
      maxLabel: 'SUI_MAX_BORROW_AMOUNT_RAW'
    });
  }

  if (action.type === 'OBSERVE') {
    return allow();
  }

  return deny(`Unknown action type: ${(action as { type?: string }).type ?? 'unknown'}`);
}

export function evaluateHealthGuard(
  obligation: SuilendObligationResponse,
  config: AppConfig
): { critical: boolean; reason: string | null } {
  if (obligation.borrows.length === 0) {
    return { critical: false, reason: null };
  }

  if (obligation.healthFactor >= config.sui.minHealthFactor) {
    return { critical: false, reason: null };
  }

  return {
    critical: true,
    reason: `Health factor ${obligation.healthFactor.toFixed(3)} is below SUI_MIN_HEALTH_FACTOR (${config.sui.minHealthFactor})`
  };
}

function evaluateSuilendWrite(
  details: Record<string, unknown>,
  config: AppConfig,
  opts: {
    requirePositionCreation: boolean;
    checkDryRun: boolean;
    maxAmount: bigint;
    maxLabel: string;
  }
): { allowed: boolean; reason: string } {
  if (!config.sui.enabled) {
    return deny('Sui lending is disabled');
  }

  if (opts.requirePositionCreation && !config.sui.enablePositionCreation) {
    return deny('Sui position creation is disabled');
  }

  // Bounds (allowlist + caps + positive amount) are enforced ALWAYS — including dry-run —
  // so a dry-run preview is faithful to what live policy would actually allow. Only the
  // live-execution environment requirements (keys/RPC) are skipped in dry-run below.
  const asset = String(details.asset ?? details.coinType ?? '');
  if (!asset) {
    return deny('asset is required');
  }

  if (config.sui.allowedAssets.length > 0) {
    const normalized = asset.toLowerCase();
    const allowed = config.sui.allowedAssets.some((entry) => entry.toLowerCase() === normalized);
    if (!allowed) {
      return deny('Requested asset is not in SUI_ALLOWED_ASSETS');
    }
  }

  let rawAmount: bigint;
  try {
    rawAmount = BigInt(String(details.rawAmount ?? '0'));
  } catch {
    return deny('rawAmount must be a valid integer');
  }
  if (rawAmount <= 0n) {
    return deny('rawAmount must be greater than zero');
  }

  if (rawAmount > opts.maxAmount) {
    return deny(`Requested amount exceeds ${opts.maxLabel}`);
  }

  if (opts.checkDryRun && config.runtime.dryRun) {
    return allow();
  }

  if (!config.sui.rpcUrl) {
    return deny('SUI_RPC_URL is missing');
  }

  if (!config.sui.privateKey) {
    return deny('AGENT_SUI_PRIVATE_KEY is missing');
  }

  return allow();
}

function allow(): { allowed: true; reason: string } {
  return { allowed: true, reason: 'allowed' };
}

function deny(reason: string): { allowed: false; reason: string } {
  return { allowed: false, reason };
}
