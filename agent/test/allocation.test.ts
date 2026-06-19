import { describe, expect, test } from 'bun:test';
import {
  type AllocationResult,
  borrowApr,
  netSupplyApr,
  type ReserveCurve,
  solveAllocation,
  supplyApr,
  utilizationAfterDeposit
} from '../src/core/allocation.js';
import type { LendingProtocol } from '../src/types.js';

const DECIMALS = 6;

/** USDC-like raw amount (6 decimals). */
function usdc(amount: number): string {
  return BigInt(Math.round(amount * 10 ** DECIMALS)).toString();
}

function curve(protocol: LendingProtocol, overrides: Partial<ReserveCurve> = {}): ReserveCurve {
  return {
    protocol,
    asset: 'usdc',
    coinType: `0x${protocol}::usdc::USDC`,
    // Kinked curve: flat to the 80% kink, steep above it.
    borrowAprPoints: [
      { util: 0, apr: 0 },
      { util: 0.8, apr: 8 },
      { util: 1, apr: 60 }
    ],
    reserveFactorPct: 20,
    borrowedRaw: usdc(800_000),
    availableLiquidityRaw: usdc(200_000),
    decimals: DECIMALS,
    price: 1,
    rewardSupplyApr: 0,
    ...overrides
  };
}

function legFor(result: AllocationResult, protocol: LendingProtocol): bigint {
  const leg = result.allocations.find((entry) => entry.protocol === protocol);
  return leg ? BigInt(leg.xRaw) : 0n;
}

describe('curve evaluation', () => {
  test('borrowApr interpolates linearly between control points', () => {
    const c = curve('suilend');
    expect(borrowApr(c, 0)).toBe(0);
    expect(borrowApr(c, 0.8)).toBe(8);
    expect(borrowApr(c, 0.4)).toBeCloseTo(4, 6); // halfway up the first segment
    expect(borrowApr(c, 0.9)).toBeCloseTo(34, 6); // halfway up the steep segment
  });

  test('borrowApr clamps outside the control-point range', () => {
    const c = curve('suilend');
    expect(borrowApr(c, -1)).toBe(0);
    expect(borrowApr(c, 2)).toBe(60);
  });

  test('supplyApr = borrowApr * U * (1 - reserveFactor)', () => {
    const c = curve('suilend');
    // At U=0.8: 8 * 0.8 * (1 - 0.2) = 5.12
    expect(supplyApr(c, 0.8)).toBeCloseTo(5.12, 6);
  });

  test('depositing lowers utilization and thus supply APR', () => {
    const c = curve('suilend'); // current U = 0.8
    expect(utilizationAfterDeposit(c, usdc(0))).toBeCloseTo(0.8, 6);
    // Add 1,000,000 USDC: U = 800k / (800k + 200k + 1,000,000) = 0.4
    expect(utilizationAfterDeposit(c, usdc(1_000_000))).toBeCloseTo(0.4, 6);
    expect(netSupplyApr(c, usdc(1_000_000))).toBeLessThan(netSupplyApr(c, usdc(0)));
  });

  test('rewardSupplyApr is additive to the base supply APR', () => {
    const base = curve('suilend');
    const rewarded = curve('navi', { rewardSupplyApr: 3 });
    expect(netSupplyApr(rewarded, usdc(0))).toBeCloseTo(netSupplyApr(base, usdc(0)) + 3, 6);
  });
});

describe('solveAllocation', () => {
  test('splits equally across identical curves', () => {
    const result = solveAllocation({
      curves: [curve('suilend'), curve('navi')],
      budgetRaw: usdc(100_000)
    });

    const a = legFor(result, 'suilend');
    const b = legFor(result, 'navi');
    expect(result.allocations.length).toBe(2);
    // Symmetric problem -> ~50/50 (allow tiny bisection/rounding slack).
    const diff = a > b ? a - b : b - a;
    expect(Number(diff)).toBeLessThan(Number(BigInt(usdc(100_000))) * 0.01);
    expect(BigInt(result.allocatedRaw)).toBe(BigInt(usdc(100_000)));
  });

  test('a steeper (shallower) curve receives less than an equally-priced deep curve', () => {
    // Both start at U=0.8 (identical spot APR), but `shallow` has 1/100th the
    // liquidity, so each deposited unit sinks its rate far faster.
    const deep = curve('suilend', {
      borrowedRaw: usdc(8_000_000),
      availableLiquidityRaw: usdc(2_000_000)
    });
    const shallow = curve('navi', {
      borrowedRaw: usdc(80_000),
      availableLiquidityRaw: usdc(20_000)
    });

    const result = solveAllocation({ curves: [deep, shallow], budgetRaw: usdc(100_000) });

    const deepAlloc = legFor(result, 'suilend');
    const shallowAlloc = legFor(result, 'navi');
    expect(deepAlloc).toBeGreaterThan(shallowAlloc);
    expect(shallowAlloc).toBeGreaterThan(0n); // still funded, just less
  });

  test('deploys the whole budget into the single best curve when budget is below minPosition', () => {
    const low = curve('navi', {
      borrowAprPoints: [
        { util: 0, apr: 0 },
        { util: 1, apr: 10 }
      ]
    });
    const high = curve('suilend', { rewardSupplyApr: 5 }); // clearly higher net APR

    const result = solveAllocation({
      curves: [low, high],
      budgetRaw: usdc(100),
      minPositionRaw: usdc(200)
    });

    expect(result.allocations.length).toBe(1);
    expect(result.allocations[0]?.protocol).toBe('suilend');
    expect(BigInt(result.allocatedRaw)).toBe(BigInt(usdc(100)));
  });

  test('respects per-protocol caps and reports the unallocatable remainder', () => {
    const result = solveAllocation({
      curves: [curve('suilend'), curve('navi')],
      budgetRaw: usdc(100_000),
      perProtocolCapRaw: usdc(30_000) // 2 legs * 30k cap < 100k budget
    });

    for (const leg of result.allocations) {
      expect(BigInt(leg.xRaw)).toBeLessThanOrEqual(BigInt(usdc(30_000)));
    }
    expect(BigInt(result.allocatedRaw)).toBe(BigInt(usdc(60_000)));
    expect(BigInt(result.unallocatedRaw)).toBe(BigInt(usdc(40_000)));
  });

  test('blended APR beats dumping the whole budget into the highest-spot pool', () => {
    const budget = usdc(400_000); // large vs each pool's depth, so own-impact bites
    const a = curve('suilend');
    const b = curve('navi');

    const result = solveAllocation({ curves: [a, b], budgetRaw: budget });

    // Naive heuristic: everything into the top spot-APR pool (here they tie -> pool a).
    const naiveApr = netSupplyApr(a, budget);
    expect(result.blendedNetApr).toBeGreaterThan(naiveApr);
    // Earlier units earn more than the marginal unit, so the average exceeds the water line.
    expect(result.blendedNetApr).toBeGreaterThanOrEqual(result.marginalApr);
  });

  test('returns empty for zero budget or no curves', () => {
    expect(solveAllocation({ curves: [], budgetRaw: usdc(100) }).allocations).toEqual([]);
    const zero = solveAllocation({ curves: [curve('suilend')], budgetRaw: usdc(0) });
    expect(zero.allocations).toEqual([]);
    expect(zero.unallocatedRaw).toBe('0');
  });
});
