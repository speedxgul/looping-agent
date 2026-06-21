import { describe, expect, it } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import type { ActionIntent } from '../src/core/actionIntent.js';
import { supplyLegsNeedingRefresh } from '../src/core/oracleRefresh.js';
import {
  type AllocationLeg,
  type AllocationRefs,
  buildVerifiedAllocationTx,
  type VerifiedSupplyRefs
} from '../src/core/verifiedSupplyTx.js';

const ascii = (s: string) => Array.from(new TextEncoder().encode(s));

const baseIntent = (protocolId: number): ActionIntent => ({
  schemaVersion: 1,
  chainId: [0x04],
  treasuryId: `0x${'00'.repeat(31)}01`,
  agentCapId: `0x${'00'.repeat(31)}02`,
  nonce: 1n,
  expiresAtMs: 1_700_000_100_000n,
  actionKind: 0,
  protocolId,
  assetType: ascii('USDC'),
  amount: 1000n,
  minHealthFactorBps: 0n,
  maxProtocolExposure: 0n,
  policyHash: Array(32).fill(0x11),
  inputHash: Array(32).fill(0x22),
  rationaleHash: Array(32).fill(0x33)
});

const leg = (protocolId: number): AllocationLeg => ({
  intent: baseIntent(protocolId),
  signatureHex: 'ab'.repeat(64)
});

const REFS: VerifiedSupplyRefs = {
  packageId: `0x${'ab'.repeat(32)}`,
  coinType: '0x2::sui::SUI',
  registryId: `0x${'01'.repeat(32)}`,
  treasuryId: `0x${'02'.repeat(32)}`,
  enclaveId: `0x${'03'.repeat(32)}`,
  agentCapId: `0x${'04'.repeat(32)}`
};

const commandsOf = (tx: Transaction) =>
  (tx.getData().commands ?? (tx.getData() as { transactions?: unknown[] }).transactions ?? []) as Array<{
    MoveCall?: { function: string };
    SplitCoins?: unknown;
  }>;

describe('supplyLegsNeedingRefresh', () => {
  it('flags only Suilend (protocolId 0) on the deposit side', () => {
    expect([...supplyLegsNeedingRefresh([leg(0)])]).toEqual([0]);
  });

  it('does NOT flag scallop, navi, or mock deposits', () => {
    // navi deposit needs no refresh (only its withdraw does); scallop & mock are oracle-free
    expect(supplyLegsNeedingRefresh([leg(1), leg(2), leg(255)]).size).toBe(0);
  });

  it('flags Suilend out of a mixed allocation, once', () => {
    const ids = supplyLegsNeedingRefresh([leg(0), leg(1), leg(0), leg(255)]);
    expect([...ids]).toEqual([0]);
  });

  it('returns empty for no legs', () => {
    expect(supplyLegsNeedingRefresh([]).size).toBe(0);
  });
});

describe('buildVerifiedAllocationTx prepend seam', () => {
  it('appends supply commands AFTER an existing refresh prelude, preserving order', () => {
    // Stand in for an oracle-refresh prelude already added to the tx.
    const tx = new Transaction();
    tx.splitCoins(tx.gas, [tx.pure.u64(1n)]);

    const refs: AllocationRefs = { mock: REFS };
    const out = buildVerifiedAllocationTx([leg(255)], refs, 1_700_000_000_000n, tx);

    expect(out).toBe(tx); // same tx, not a fresh one
    const cmds = commandsOf(out);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]?.SplitCoins).toBeDefined(); // prelude stays first
    expect(cmds[1]?.MoveCall?.function).toBe('verified_supply_entry'); // supply appended after
  });

  it('still works with no prelude (fresh tx default)', () => {
    const out = buildVerifiedAllocationTx([leg(255)], { mock: REFS }, 1_700_000_000_000n);
    const cmds = commandsOf(out);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.MoveCall?.function).toBe('verified_supply_entry');
  });
});
