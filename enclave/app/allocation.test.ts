import { expect, test, describe } from 'bun:test';
import { solveAllocation } from './allocation.ts';
import type { ReserveCurve, SolveAllocationInput } from './allocation.ts';

// Two-pool USDC input: suilend at 5% borrow APR, navi at 3% borrow APR
// Both at 80% utilization, 6 decimals (USDC), no reward APR, 10% reserve factor.
const DECIMALS = 6;
const ONE_USDC = 1_000_000n; // 1 USDC in raw units

const suilendCurve: ReserveCurve = {
  protocol: 'suilend',
  asset: 'USDC',
  coinType: '0x2::usdc::USDC',
  borrowAprPoints: [
    { util: 0, apr: 0 },
    { util: 0.8, apr: 5 },
    { util: 1, apr: 50 }
  ],
  reserveFactorPct: 10,
  borrowedRaw: '800000000', // 800 USDC borrowed
  availableLiquidityRaw: '200000000', // 200 USDC available → 80% utilization
  decimals: DECIMALS,
  price: 1.0,
  rewardSupplyApr: 0
};

const naviCurve: ReserveCurve = {
  protocol: 'navi',
  asset: 'USDC',
  coinType: '0x2::usdc::USDC',
  borrowAprPoints: [
    { util: 0, apr: 0 },
    { util: 0.8, apr: 3 },
    { util: 1, apr: 30 }
  ],
  reserveFactorPct: 10,
  borrowedRaw: '800000000', // 800 USDC borrowed
  availableLiquidityRaw: '200000000', // 200 USDC available → 80% utilization
  decimals: DECIMALS,
  price: 1.0,
  rewardSupplyApr: 0
};

const DEPOSIT_RAW = 100n * ONE_USDC; // 100 USDC budget

describe('solveAllocation', () => {
  test('returns a valid AllocationResult for 2-pool input', () => {
    const input: SolveAllocationInput = {
      curves: [suilendCurve, naviCurve],
      budgetRaw: DEPOSIT_RAW
    };

    const result = solveAllocation(input);

    // Must have at least one allocation leg
    expect(result.allocations.length).toBeGreaterThan(0);

    // blendedNetApr must be a finite positive number
    expect(Number.isFinite(result.blendedNetApr)).toBe(true);
    expect(result.blendedNetApr).toBeGreaterThan(0);

    // budgetRaw must match the input
    expect(result.budgetRaw).toBe(DEPOSIT_RAW.toString());

    // allocated + unallocated must equal the budget
    const allocated = BigInt(result.allocatedRaw);
    const unallocated = BigInt(result.unallocatedRaw);
    expect(allocated + unallocated).toBe(DEPOSIT_RAW);

    // allocated amount must be <= budget
    expect(allocated).toBeLessThanOrEqual(DEPOSIT_RAW);
  });

  test('leg raw amounts sum to approximately the deposit', () => {
    const input: SolveAllocationInput = {
      curves: [suilendCurve, naviCurve],
      budgetRaw: DEPOSIT_RAW
    };

    const result = solveAllocation(input);

    const legSum = result.allocations.reduce((sum, leg) => sum + BigInt(leg.xRaw), 0n);
    // The sum of individual legs must equal allocatedRaw
    expect(legSum.toString()).toBe(result.allocatedRaw);

    // And allocated raw must be close to the budget (within rounding: at most 2 raw units short)
    const diff = DEPOSIT_RAW - BigInt(result.allocatedRaw);
    expect(diff).toBeGreaterThanOrEqual(0n);
    expect(diff).toBeLessThanOrEqual(2n);
  });

  test('suilend leg gets more allocation (higher APR)', () => {
    const input: SolveAllocationInput = {
      curves: [suilendCurve, naviCurve],
      budgetRaw: DEPOSIT_RAW
    };

    const result = solveAllocation(input);

    const suilendLeg = result.allocations.find((l) => l.protocol === 'suilend');
    const naviLeg = result.allocations.find((l) => l.protocol === 'navi');

    // Suilend has higher APR so its leg should be larger (or at least exist)
    expect(suilendLeg).toBeDefined();
    if (suilendLeg && naviLeg) {
      expect(BigInt(suilendLeg.xRaw)).toBeGreaterThanOrEqual(BigInt(naviLeg.xRaw));
    }
  });

  test('returns empty result for zero budget', () => {
    const input: SolveAllocationInput = {
      curves: [suilendCurve, naviCurve],
      budgetRaw: 0n
    };

    const result = solveAllocation(input);

    expect(result.allocations.length).toBe(0);
    expect(result.blendedNetApr).toBe(0);
    expect(result.allocatedRaw).toBe('0');
  });

  test('respects perProtocolCapRaw cap', () => {
    const cap = 30n * ONE_USDC; // cap each protocol at 30 USDC
    const input: SolveAllocationInput = {
      curves: [suilendCurve, naviCurve],
      budgetRaw: DEPOSIT_RAW,
      perProtocolCapRaw: cap
    };

    const result = solveAllocation(input);

    for (const leg of result.allocations) {
      expect(BigInt(leg.xRaw)).toBeLessThanOrEqual(cap);
    }
  });
});
