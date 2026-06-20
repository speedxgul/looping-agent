import { expect, test, describe } from 'bun:test';
import { decide } from './decide.ts';
import type { DecideInput } from './decide.ts';
import type { ReserveCurve } from './allocation.ts';

// Fixed signing key — all zeros except 0x11 fill (matches action_intent self-test convention).
const SIGNING_KEY = new Uint8Array(32).fill(0x11);

// Deterministic 2-pool USDC setup: suilend (5% borrow APR) > navi (3% borrow APR).
const DECIMALS = 6;
const ONE_USDC = 1_000_000n;

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
  borrowedRaw: '800000000',
  availableLiquidityRaw: '200000000',
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
  borrowedRaw: '800000000',
  availableLiquidityRaw: '200000000',
  decimals: DECIMALS,
  price: 1.0,
  rewardSupplyApr: 0
};

const BASE_INPUT: DecideInput = {
  curves: [suilendCurve, naviCurve],
  depositRaw: 100n * ONE_USDC,
  treasuryId: '0x' + 'ab'.repeat(32),
  agentCapId: '0x' + 'cd'.repeat(32),
  perTxCapRaw: 200n * ONE_USDC, // set above the deposit so it doesn't clamp
  nonce: 42n,
  expiresAtMs: 1_800_000_000_000n,
  assetType: Array.from(new TextEncoder().encode('USDC')),
  chainId: [0x04],
  timestampMs: 1_700_000_000_000n
};

describe('decide', () => {
  test('DETERMINISTIC: identical input produces identical intent and signature', () => {
    const r1 = decide(BASE_INPUT, SIGNING_KEY);
    const r2 = decide(BASE_INPUT, SIGNING_KEY);

    expect(r1.signature).toBe(r2.signature);
    expect(r1.intent.amount).toBe(r2.intent.amount);
    expect(r1.intent.protocolId).toBe(r2.intent.protocolId);
    expect(r1.intent.nonce).toBe(r2.intent.nonce);
  });

  test('BOUNDED: perTxCapRaw clamps the amount when below the top leg raw', () => {
    // Set a cap that is definitely below the full deposit (100 USDC).
    // The solver will try to assign most of the budget to suilend; the cap clamps it.
    const cap = 10n * ONE_USDC; // 10 USDC cap — well below the 100 USDC deposit

    const input: DecideInput = { ...BASE_INPUT, perTxCapRaw: cap };
    const { intent } = decide(input, SIGNING_KEY);

    expect(intent.amount).toBe(cap);
    expect(intent.amount).toBeLessThanOrEqual(cap);
  });

  test('SHAPE: signature is 128 hex chars (64 bytes)', () => {
    const { signature } = decide(BASE_INPUT, SIGNING_KEY);

    expect(signature.length).toBe(128);
    // Verify it is valid hex
    expect(/^[0-9a-f]+$/.test(signature)).toBe(true);
  });

  test('SHAPE: protocolId is a known value (suilend=0, navi=2, scallop=1)', () => {
    const { intent } = decide(BASE_INPUT, SIGNING_KEY);

    const KNOWN_IDS = [0, 1, 2, 255];
    expect(KNOWN_IDS).toContain(intent.protocolId);
  });

  test('SHAPE: intent fields have correct types and values', () => {
    const { intent } = decide(BASE_INPUT, SIGNING_KEY);

    expect(intent.schemaVersion).toBe(1);
    expect(intent.actionKind).toBe(0);
    expect(intent.nonce).toBe(BASE_INPUT.nonce);
    expect(intent.expiresAtMs).toBe(BASE_INPUT.expiresAtMs);
    expect(intent.treasuryId).toBe(BASE_INPUT.treasuryId);
    expect(intent.agentCapId).toBe(BASE_INPUT.agentCapId);

    // Byte arrays must have correct sizes
    expect(intent.chainId).toBeInstanceOf(Uint8Array);
    expect(intent.chainId[0]).toBe(0x04);
    expect(intent.policyHash.length).toBe(32);
    expect(intent.inputHash.length).toBe(32);
    expect(intent.rationaleHash.length).toBe(32);

    // amount must be > 0 (we deposited 100 USDC)
    expect(intent.amount).toBeGreaterThan(0n);
  });

  test('SHAPE: suilend gets the top slot (highest APR → protocolId 0)', () => {
    const { intent } = decide(BASE_INPUT, SIGNING_KEY);

    // suilend has higher APR, so it should be the top leg → protocolId = 0
    expect(intent.protocolId).toBe(0);
  });

  test('DETERMINISTIC: different curves produce different signatures', () => {
    const r1 = decide(BASE_INPUT, SIGNING_KEY);

    // Swap suilend/navi APRs to change the result
    const altCurves: ReserveCurve[] = [
      { ...suilendCurve, borrowAprPoints: [{ util: 0, apr: 0 }, { util: 0.8, apr: 3 }, { util: 1, apr: 30 }] },
      { ...naviCurve, borrowAprPoints: [{ util: 0, apr: 0 }, { util: 0.8, apr: 5 }, { util: 1, apr: 50 }] }
    ];
    const r2 = decide({ ...BASE_INPUT, curves: altCurves }, SIGNING_KEY);

    // Different input curves → different inputHash → different signature
    expect(r1.signature).not.toBe(r2.signature);
  });
});
