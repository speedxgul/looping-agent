import type {
  AgentAction,
  AppConfig,
  LendingProtocol,
  NormalizedPositions,
  PositionActionKind
} from '../types.js';

const ACTION_KIND: Record<string, PositionActionKind> = {
  LENDING_SUPPLY: 'supply',
  LENDING_WITHDRAW: 'withdraw',
  LENDING_BORROW: 'borrow',
  LENDING_REPAY: 'repay',
  // Deprecated Suilend-specific aliases.
  SUILEND_SUPPLY: 'supply',
  SUILEND_WITHDRAW: 'withdraw',
  SUILEND_BORROW: 'borrow',
  SUILEND_REPAY: 'repay'
};

export function evaluateActionPolicy(
  action: AgentAction,
  config: AppConfig
): { allowed: boolean; reason: string } {
  if (action.type === 'OBSERVE') {
    return allow();
  }

  const kind = ACTION_KIND[action.type];
  if (!kind) {
    return deny(`Unknown action type: ${(action as { type?: string }).type ?? 'unknown'}`);
  }

  const details = action.details ?? {};
  // Suilend-specific aliases imply the suilend protocol; generic actions read details.protocol.
  const protocol = resolveProtocol(action.type, details);

  return evaluateLendingWrite(kind, protocol, details, config);
}

export function evaluateLendingWrite(
  kind: PositionActionKind,
  protocol: LendingProtocol,
  details: Record<string, unknown>,
  config: AppConfig
): { allowed: boolean; reason: string } {
  if (!config.sui.enabled) {
    return deny('Sui lending is disabled');
  }

  if (!config.sui.allowedProtocols.includes(protocol)) {
    return deny(`Protocol ${protocol} is not in SUI_ALLOWED_PROTOCOLS`);
  }

  if (!config.sui.protocols[protocol]?.write) {
    return deny(`Writes to ${protocol} are disabled (set ENABLE_${protocol.toUpperCase()})`);
  }

  if (kind === 'supply' && !config.sui.enablePositionCreation) {
    return deny('Sui position creation is disabled');
  }

  if (kind === 'borrow' && !config.sui.enableBorrow) {
    return deny('Sui borrow is disabled');
  }

  // Bounds (allowlist + caps + positive amount) are enforced ALWAYS — including dry-run —
  // so a dry-run preview is faithful to what live policy would actually allow.
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

  const maxAmount = kind === 'borrow' || kind === 'repay' ? config.sui.maxBorrowRaw : config.sui.maxSupplyRaw;
  const maxLabel =
    kind === 'borrow' || kind === 'repay' ? 'SUI_MAX_BORROW_AMOUNT_RAW' : 'SUI_MAX_SUPPLY_AMOUNT_RAW';
  if (rawAmount > maxAmount) {
    return deny(`Requested amount exceeds ${maxLabel}`);
  }

  // Borrow-specific: fail closed if the projected health factor is unknown/NaN or below the floor.
  if (kind === 'borrow') {
    const projectedHealth = Number(details.projectedHealthFactor ?? Number.NaN);
    if (!Number.isFinite(projectedHealth) || projectedHealth < config.sui.minHealthFactor) {
      return deny(
        `Borrow would push health factor below SUI_MIN_HEALTH_FACTOR (${config.sui.minHealthFactor})`
      );
    }
  }

  // Dry-run previews skip live-execution environment requirements (keys/RPC) only.
  if (config.runtime.dryRun) {
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

export function evaluateHealthGuard(
  positions: NormalizedPositions,
  config: AppConfig
): { critical: boolean; reason: string | null } {
  if (positions.borrows.length === 0) {
    return { critical: false, reason: null };
  }

  if (positions.healthFactor >= config.sui.minHealthFactor) {
    return { critical: false, reason: null };
  }

  return {
    critical: true,
    reason: `Health factor ${positions.healthFactor.toFixed(3)} is below SUI_MIN_HEALTH_FACTOR (${config.sui.minHealthFactor}) on ${positions.protocol}`
  };
}

/**
 * Rebalance hysteresis: only worth moving already-supplied funds when the better
 * protocol beats the current one by more than the configured basis-point delta.
 * Prevents APR-noise churn that bleeds gas.
 */
export function shouldRebalance(
  currentApr: number,
  candidateApr: number,
  config: AppConfig
): { rebalance: boolean; deltaBps: number; reason: string } {
  const deltaBps = Math.round((candidateApr - currentApr) * 100);
  if (deltaBps < config.sui.rebalanceMinAprDeltaBps) {
    return {
      rebalance: false,
      deltaBps,
      reason: `APR improvement ${deltaBps}bps is below SUI_REBALANCE_MIN_APR_DELTA_BPS (${config.sui.rebalanceMinAprDeltaBps})`
    };
  }
  return { rebalance: true, deltaBps, reason: 'APR improvement clears rebalance threshold' };
}

export interface RebalanceBreakevenInput {
  /** Current net supply APR of the position, percent. */
  currentNetApr: number;
  /** Net supply APR if the funds were moved to the target leg, percent. */
  targetNetApr: number;
  /** Size of the position being moved, in USD. */
  amountUsd: number;
  /** Amortization horizon in days (how long we expect to hold the new position). */
  horizonDays: number;
  /** Estimated round-trip execution cost (gas + slippage) in USD. */
  costUsd: number;
}

/**
 * Amortized breakeven gate generalizing {@link shouldRebalance}. A move clears the
 * gate only when (a) the APR improvement beats the bps floor (hysteresis, reused
 * from `rebalanceMinAprDeltaBps`) AND (b) the expected extra yield over the horizon
 * exceeds the execution cost:
 *
 *   expectedGainUsd = (targetNetApr - currentNetApr)/100 · amountUsd · (horizonDays/365)
 *   act ⟺ deltaBps ≥ floor  AND  expectedGainUsd > costUsd
 *
 * This is what makes moving already-deployed capital (withdraw A → supply B) worth
 * the gas; deploying fresh idle capital doesn't need it (no exit cost on the old leg).
 */
export function evaluateRebalanceBreakeven(
  input: RebalanceBreakevenInput,
  config: AppConfig
): { act: boolean; deltaBps: number; expectedGainUsd: number; costUsd: number; reason: string } {
  const floor = shouldRebalance(input.currentNetApr, input.targetNetApr, config);
  const horizonYears = Math.max(0, input.horizonDays) / 365;
  const expectedGainUsd =
    ((input.targetNetApr - input.currentNetApr) / 100) * Math.max(0, input.amountUsd) * horizonYears;
  const costUsd = Math.max(0, input.costUsd);

  if (!floor.rebalance) {
    return { act: false, deltaBps: floor.deltaBps, expectedGainUsd, costUsd, reason: floor.reason };
  }

  if (expectedGainUsd <= costUsd) {
    return {
      act: false,
      deltaBps: floor.deltaBps,
      expectedGainUsd,
      costUsd,
      reason: `Expected gain $${expectedGainUsd.toFixed(4)} over ${input.horizonDays}d does not exceed cost $${costUsd.toFixed(4)}`
    };
  }

  return {
    act: true,
    deltaBps: floor.deltaBps,
    expectedGainUsd,
    costUsd,
    reason: `Expected gain $${expectedGainUsd.toFixed(4)} over ${input.horizonDays}d clears cost $${costUsd.toFixed(4)} and the ${floor.deltaBps}bps floor`
  };
}

function resolveProtocol(actionType: string, details: Record<string, unknown>): LendingProtocol {
  if (actionType.startsWith('SUILEND_')) {
    return 'suilend';
  }
  const raw = String(details.protocol ?? 'suilend').toLowerCase();
  if (raw === 'navi' || raw === 'scallop' || raw === 'suilend') {
    return raw;
  }
  return 'suilend';
}

function allow(): { allowed: true; reason: string } {
  return { allowed: true, reason: 'allowed' };
}

function deny(reason: string): { allowed: false; reason: string } {
  return { allowed: false, reason };
}
