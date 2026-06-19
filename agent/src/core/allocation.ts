import type { LendingProtocol } from '../types.js';

/**
 * Convex, own-impact-aware allocation solver.
 *
 * The naive "deposit into the highest spot APR" heuristic is provably suboptimal:
 * a lending pool's supply rate FALLS as you deposit into it (your own capital
 * lowers utilization). The optimal split across N pools maximizes total interest
 *   max  Σ x_i · R_i(x_i)   s.t.  Σ x_i = budget,  0 ≤ x_i ≤ cap_i
 * whose Lagrangian first-order condition is: the MARGINAL yield
 *   d/dx_i [x_i · R_i(x_i)] = R_i(x_i) + x_i · R_i'(x_i)
 * is equal across every funded pool. That equalized level is the "water line";
 * solving for it is the classic water-filling solution. This module computes it.
 *
 * All rate values are in PERCENT (e.g. 5.0 = 5%). Utilization is a fraction [0,1].
 * Amounts crossing the public boundary are raw integer strings (token smallest
 * units); the solver works internally in floating-point token units for the rate
 * math and converts back to raw on the way out.
 */

/** A single (utilization, borrow APR) control point of a reserve's rate curve. */
export interface BorrowAprPoint {
  /** Utilization fraction in [0, 1]. */
  util: number;
  /** Borrow APR in percent at that utilization. */
  apr: number;
}

/**
 * A protocol's reserve for one asset, normalized so the solver is protocol-agnostic.
 * The borrow curve is a piecewise-linear set of control points (Suilend exposes this
 * natively; NAVI/Scallop kink params are converted into it).
 */
export interface ReserveCurve {
  protocol: LendingProtocol;
  asset: string;
  coinType: string;
  /** Borrow APR curve as control points; need not be pre-sorted. */
  borrowAprPoints: BorrowAprPoint[];
  /** Reserve factor (protocol interest spread) in percent, e.g. 20 = 20%. */
  reserveFactorPct: number;
  /** Currently borrowed amount, raw token units. */
  borrowedRaw: string;
  /** Currently available (un-borrowed) liquidity, raw token units. */
  availableLiquidityRaw: string;
  /** Optional protocol-side deposit cap, raw token units. */
  depositCapRaw?: string;
  decimals: number;
  /** USD price (for reporting; the solver allocates within one asset). */
  price: number;
  /** Reward/incentive supply APR in percent, additive to base supply APR. */
  rewardSupplyApr: number;
}

export interface AllocationLeg {
  protocol: LendingProtocol;
  asset: string;
  coinType: string;
  /** Allocated amount, raw token units. */
  xRaw: string;
  /** Net supply APR (percent) this leg earns at its allocated amount. */
  netSupplyApr: number;
  /** Fraction of the allocated budget on this leg, [0, 1]. */
  share: number;
}

export interface AllocationResult {
  allocations: AllocationLeg[];
  /** Budget-weighted net supply APR across funded legs, percent. */
  blendedNetApr: number;
  /** The equalized marginal yield level (the "water line"), percent. */
  marginalApr: number;
  budgetRaw: string;
  allocatedRaw: string;
  /** Budget that could not be placed (caps below budget), raw token units. */
  unallocatedRaw: string;
  iterations: number;
}

export interface SolveAllocationInput {
  curves: ReserveCurve[];
  budgetRaw: bigint | string;
  /** Global per-leg cap (e.g. config maxSupplyRaw); combined with each curve's own cap. */
  perProtocolCapRaw?: bigint | string;
  /** Minimum size for any single funded leg; smaller legs are pruned/merged. */
  minPositionRaw?: bigint | string;
}

const LAMBDA_ITERATIONS = 80;
const X_ITERATIONS = 60;

// === Curve evaluation ===

/** Borrow APR (percent) at utilization `u`, by linear interpolation across control points. */
export function borrowApr(curve: ReserveCurve, u: number): number {
  const points = [...curve.borrowAprPoints].sort((a, b) => a.util - b.util);
  const first = points[0];
  if (!first) {
    return 0;
  }
  const util = clamp(u, 0, 1);
  if (util <= first.util) {
    return first.apr;
  }
  const last = points[points.length - 1];
  if (!last) {
    return first.apr;
  }
  if (util >= last.util) {
    return last.apr;
  }
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    if (!prev || !next) {
      continue;
    }
    if (util <= next.util) {
      const span = next.util - prev.util;
      if (span <= 0) {
        return next.apr;
      }
      const t = (util - prev.util) / span;
      return prev.apr + t * (next.apr - prev.apr);
    }
  }
  return last.apr;
}

/** Base supply APR (percent, excluding rewards) at utilization `u`. */
export function supplyApr(curve: ReserveCurve, u: number): number {
  const util = clamp(u, 0, 1);
  return borrowApr(curve, util) * util * (1 - curve.reserveFactorPct / 100);
}

/** Utilization fraction after adding `xRaw` of supply (deposit lowers utilization). */
export function utilizationAfterDeposit(curve: ReserveCurve, xRaw: bigint | string | number): number {
  const x = toUnits(xRaw, curve.decimals);
  const borrowed = toUnits(curve.borrowedRaw, curve.decimals);
  const available = toUnits(curve.availableLiquidityRaw, curve.decimals);
  const denom = borrowed + available + x;
  if (denom <= 0) {
    return 0;
  }
  return clamp(borrowed / denom, 0, 1);
}

/**
 * Net supply APR (percent) earned if `xRaw` more were supplied: base supply APR at
 * the post-deposit utilization plus reward APR.
 *
 * v1 treats rewardSupplyApr as fixed. v2 should decay it with the agent's share of
 * the reward pool (rewardAPR(s_i)) since incentives dilute as more capital farms them.
 */
export function netSupplyApr(curve: ReserveCurve, xRaw: bigint | string | number): number {
  const u = utilizationAfterDeposit(curve, xRaw);
  return supplyApr(curve, u) + curve.rewardSupplyApr;
}

// === Curve construction helpers (used by protocol clients) ===

/**
 * Derive the reserve factor (percent) from the known spot relationship
 * `supplyAPR = borrowAPR · U · (1 - reserveFactor)`. Scale-safe: it uses only the
 * already-converted spot APRs and utilization, so protocols whose raw reserve-factor
 * units are ambiguous (NAVI/Scallop) don't need a unit guess.
 */
export function deriveReserveFactorPct(
  spotBorrowAprPct: number,
  spotSupplyAprPct: number,
  utilization: number
): number {
  const denom = spotBorrowAprPct * utilization;
  if (denom <= 0) {
    return 0;
  }
  const factor = 1 - spotSupplyAprPct / denom;
  return clamp(factor, 0, 0.95) * 100;
}

/**
 * Spot-anchored linear fallback curve: a line through the origin and the current
 * operating point `(utilization, spotBorrowAprPct)`. Loses the kink but is always
 * monotonic and correct in direction (more deposits -> lower utilization -> lower
 * rate), so it still beats the naive highest-APR heuristic.
 */
export function fallbackBorrowAprPoints(utilization: number, spotBorrowAprPct: number): BorrowAprPoint[] {
  if (utilization <= 0 || !Number.isFinite(spotBorrowAprPct)) {
    return [
      { util: 0, apr: 0 },
      { util: 1, apr: Math.max(0, spotBorrowAprPct) }
    ];
  }
  const slope = spotBorrowAprPct / utilization;
  return [
    { util: 0, apr: 0 },
    { util: 1, apr: slope }
  ];
}

/**
 * Return `candidate` control points if they reproduce the observed spot borrow APR
 * at the current utilization (within tolerance), else the spot-anchored linear
 * fallback. This guards against mis-scaled kink params from a protocol SDK.
 */
export function validatedBorrowAprPoints(
  candidate: BorrowAprPoint[],
  utilization: number,
  spotBorrowAprPct: number
): BorrowAprPoint[] {
  if (candidate.length >= 2 && Number.isFinite(spotBorrowAprPct)) {
    const reproduced = borrowApr({ borrowAprPoints: candidate } as ReserveCurve, utilization);
    const tolerance = Math.max(0.5, Math.abs(spotBorrowAprPct) * 0.15);
    if (Number.isFinite(reproduced) && Math.abs(reproduced - spotBorrowAprPct) <= tolerance) {
      return candidate;
    }
  }
  return fallbackBorrowAprPoints(utilization, spotBorrowAprPct);
}

// === Solver ===

/**
 * Solve the optimal allocation of `budgetRaw` across `curves` by equalizing the
 * marginal net yield (water-filling). Returns per-leg raw amounts plus the blended
 * and marginal APRs.
 */
export function solveAllocation(input: SolveAllocationInput): AllocationResult {
  const { curves } = input;
  const budgetRaw = toBigInt(input.budgetRaw);

  const empty = (): AllocationResult => ({
    allocations: [],
    blendedNetApr: 0,
    marginalApr: 0,
    budgetRaw: budgetRaw.toString(),
    allocatedRaw: '0',
    unallocatedRaw: budgetRaw.toString(),
    iterations: 0
  });

  const firstCurve = curves[0];
  if (!firstCurve || budgetRaw <= 0n) {
    return empty();
  }

  // Work in token units (the asset is shared across these curves, so decimals match).
  const decimals = firstCurve.decimals;
  const budgetUnits = toUnits(budgetRaw, decimals);
  const globalCapUnits =
    input.perProtocolCapRaw !== undefined
      ? toUnits(input.perProtocolCapRaw, decimals)
      : Number.POSITIVE_INFINITY;
  const minPositionUnits = input.minPositionRaw !== undefined ? toUnits(input.minPositionRaw, decimals) : 0;

  const capFor = (curve: ReserveCurve): number => {
    const ownCap =
      curve.depositCapRaw !== undefined ? toUnits(curve.depositCapRaw, decimals) : Number.POSITIVE_INFINITY;
    // A single leg can never exceed the whole budget, so bound by it too (this also
    // keeps the marginal-inversion bisection finite when no explicit cap is set).
    return Math.max(0, Math.min(globalCapUnits, ownCap, budgetUnits));
  };

  // Iteratively solve water-filling, pruning any dust legs below minPosition.
  let candidates = [...curves];
  let totalIterations = 0;

  for (let guard = 0; guard < curves.length + 1; guard += 1) {
    const solved = waterFill(candidates, budgetUnits, capFor);
    totalIterations += solved.iterations;

    const positiveLegs = solved.xUnits.filter((x) => x > 0).length;
    // Only prune dust when there are at least two funded legs to merge. A single
    // funded leg below minPosition is the "budget below minPosition -> single best"
    // case and must be kept as-is, never pruned down to a worse curve.
    if (minPositionUnits <= 0 || candidates.length <= 1 || positiveLegs <= 1) {
      return finalize(candidates, solved, decimals, budgetRaw, totalIterations);
    }

    // Prune the smallest positive leg that is below the minimum position size.
    let pruneIndex = -1;
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i += 1) {
      const x = solved.xUnits[i];
      if (x !== undefined && x > 0 && x < minPositionUnits && x < smallest) {
        smallest = x;
        pruneIndex = i;
      }
    }

    if (pruneIndex === -1) {
      return finalize(candidates, solved, decimals, budgetRaw, totalIterations);
    }

    candidates = candidates.filter((_, i) => i !== pruneIndex);
  }

  // Fallback (should be unreachable): deploy the whole budget into the single best curve.
  const best = bestSingle(curves, budgetUnits, capFor);
  return finalize(
    [best.curve],
    {
      xUnits: [best.xUnits],
      marginal: netSupplyApr(best.curve, toRaw(best.xUnits, decimals)),
      iterations: 0
    },
    decimals,
    budgetRaw,
    totalIterations
  );
}

interface WaterFillResult {
  xUnits: number[];
  marginal: number;
  iterations: number;
}

/** Core water-filling: find the marginal level λ such that Σ x_i(λ) = budget. */
function waterFill(
  curves: ReserveCurve[],
  budgetUnits: number,
  capFor: (curve: ReserveCurve) => number
): WaterFillResult {
  const caps = curves.map(capFor);
  const totalCap = caps.reduce((sum, c) => sum + c, 0);

  // Budget meets or exceeds total capacity: fill every leg to its cap.
  if (budgetUnits >= totalCap) {
    return { xUnits: caps.slice(), marginal: 0, iterations: 0 };
  }

  // λ ranges from 0 (max allocation) up to the highest first-unit marginal (≈ best spot rate).
  const lambdaHigh = Math.max(0, ...curves.map((curve) => marginalYield(curve, 0)));
  let lo = 0;
  let hi = lambdaHigh;
  let iterations = 0;

  const allocAt = (lambda: number): number[] =>
    curves.map((curve, i) => solveMarginalEquals(curve, lambda, caps[i] ?? 0));

  // Σ x_i(λ) is decreasing in λ. Bisect for the λ that places exactly the budget.
  for (let i = 0; i < LAMBDA_ITERATIONS; i += 1) {
    iterations += 1;
    const mid = (lo + hi) / 2;
    const total = allocAt(mid).reduce((sum, x) => sum + x, 0);
    if (total > budgetUnits) {
      lo = mid; // too much allocated -> raise the water line
    } else {
      hi = mid; // too little -> lower it
    }
  }

  const lambda = (lo + hi) / 2;
  return { xUnits: allocAt(lambda), marginal: lambda, iterations };
}

/** For a target marginal `lambda`, the x in [0, cap] where marginalYield(curve, x) = lambda. */
function solveMarginalEquals(curve: ReserveCurve, lambda: number, cap: number): number {
  if (cap <= 0) {
    return 0;
  }
  // marginalYield is decreasing in x. If even the first unit earns < λ, fund nothing;
  // if the last unit (at cap) still earns > λ, fund to the cap.
  if (marginalYield(curve, 0) <= lambda) {
    return 0;
  }
  if (marginalYield(curve, cap) >= lambda) {
    return cap;
  }

  let lo = 0;
  let hi = cap;
  for (let i = 0; i < X_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    if (marginalYield(curve, mid) > lambda) {
      lo = mid; // marginal still above target -> can place more
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Marginal yield (percent) of the next unit at allocation `xUnits`:
 * d/dx [x · netSupplyApr(x)], computed by central finite difference so it works for
 * any piecewise-linear curve without hand-differentiating the interpolation.
 */
function marginalYield(curve: ReserveCurve, xUnits: number): number {
  const h = Math.max(xUnits * 1e-6, 1e-6);
  const decimals = curve.decimals;
  const interest = (x: number): number => {
    const safe = Math.max(0, x);
    return safe * netSupplyApr(curve, toRaw(safe, decimals));
  };
  const lo = Math.max(0, xUnits - h);
  const hi = xUnits + h;
  return (interest(hi) - interest(lo)) / (hi - lo);
}

function bestSingle(
  curves: ReserveCurve[],
  budgetUnits: number,
  capFor: (curve: ReserveCurve) => number
): { curve: ReserveCurve; xUnits: number } {
  let best = curves[0];
  if (!best) {
    throw new Error('bestSingle requires at least one curve');
  }
  let bestApr = Number.NEGATIVE_INFINITY;
  for (const curve of curves) {
    const x = Math.min(budgetUnits, capFor(curve));
    const apr = netSupplyApr(curve, toRaw(x, curve.decimals));
    if (apr > bestApr) {
      bestApr = apr;
      best = curve;
    }
  }
  return { curve: best, xUnits: Math.min(budgetUnits, capFor(best)) };
}

function finalize(
  curves: ReserveCurve[],
  solved: WaterFillResult,
  decimals: number,
  budgetRaw: bigint,
  iterations: number
): AllocationResult {
  // Convert unit allocations to raw, then repair floor rounding so the sum never
  // exceeds the budget and any small remainder lands on the largest leg.
  const rawAmounts = solved.xUnits.map((x) => toRaw(Math.max(0, x), decimals));
  let allocated = rawAmounts.reduce((sum, r) => sum + r, 0n);

  // Flooring each leg loses < 1 raw unit, so a genuine rounding shortfall is at most
  // `legs` raw units. A larger gap is a real cap-induced shortfall and must stay
  // unallocated rather than being forced onto a leg (which would breach its cap).
  const roundingSlack = BigInt(curves.length);
  if (allocated > budgetRaw) {
    const idx = largestIndex(rawAmounts);
    const cur = rawAmounts[idx] ?? 0n;
    const overflow = allocated - budgetRaw;
    rawAmounts[idx] = cur > overflow ? cur - overflow : 0n;
    allocated = rawAmounts.reduce((sum, r) => sum + r, 0n);
  } else if (allocated < budgetRaw && budgetRaw - allocated <= roundingSlack) {
    const idx = largestIndex(rawAmounts);
    const cur = rawAmounts[idx] ?? 0n;
    if (cur > 0n) {
      rawAmounts[idx] = cur + (budgetRaw - allocated);
      allocated = budgetRaw;
    }
  }

  const allocations: AllocationLeg[] = [];
  for (let i = 0; i < curves.length; i += 1) {
    const curve = curves[i];
    const xRaw = rawAmounts[i];
    if (!curve || xRaw === undefined || xRaw <= 0n) {
      continue;
    }
    allocations.push({
      protocol: curve.protocol,
      asset: curve.asset,
      coinType: curve.coinType,
      xRaw: xRaw.toString(),
      netSupplyApr: round(netSupplyApr(curve, xRaw), 4),
      share: allocated > 0n ? Number(xRaw) / Number(allocated) : 0
    });
  }
  allocations.sort((a, b) => Number(BigInt(b.xRaw) - BigInt(a.xRaw)));

  const blendedNetApr = allocations.reduce((sum, leg) => sum + leg.netSupplyApr * leg.share, 0);

  return {
    allocations,
    blendedNetApr: round(blendedNetApr, 4),
    marginalApr: round(solved.marginal, 4),
    budgetRaw: budgetRaw.toString(),
    allocatedRaw: allocated.toString(),
    unallocatedRaw: (budgetRaw - allocated).toString(),
    iterations
  };
}

// === Helpers ===

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function largestIndex(amounts: bigint[]): number {
  let idx = 0;
  for (let i = 1; i < amounts.length; i += 1) {
    const value = amounts[i];
    const current = amounts[idx];
    if (value !== undefined && current !== undefined && value > current) {
      idx = i;
    }
  }
  return idx;
}

function toBigInt(value: bigint | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function toUnits(raw: bigint | string | number, decimals: number): number {
  if (typeof raw === 'number') {
    return raw;
  }
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  return Number(value) / 10 ** decimals;
}

function toRaw(units: number, decimals: number): bigint {
  if (!Number.isFinite(units) || units <= 0) {
    return 0n;
  }
  return BigInt(Math.floor(units * 10 ** decimals));
}
