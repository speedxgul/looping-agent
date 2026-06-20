import { describe, expect, it } from 'bun:test';
import type { ActionIntent } from '../src/core/actionIntent.js';
import { buildVerifiedSupplyTx, type VerifiedSupplyRefs } from '../src/core/verifiedSupplyTx.js';

const ascii = (s: string) => Array.from(new TextEncoder().encode(s));

const REFS: VerifiedSupplyRefs = {
  packageId: `0x${'ab'.repeat(32)}`,
  coinType: '0x2::sui::SUI',
  registryId: `0x${'01'.repeat(32)}`,
  treasuryId: `0x${'02'.repeat(32)}`,
  enclaveId: `0x${'03'.repeat(32)}`,
  agentCapId: `0x${'04'.repeat(32)}`
};

const INTENT: ActionIntent = {
  schemaVersion: 1,
  chainId: [0x04],
  treasuryId: `0x${'00'.repeat(31)}01`,
  agentCapId: `0x${'00'.repeat(31)}02`,
  nonce: 7n,
  expiresAtMs: 1_700_000_100_000n,
  actionKind: 0,
  protocolId: 0,
  assetType: ascii('USDC'),
  amount: 1000n,
  minHealthFactorBps: 0n,
  maxProtocolExposure: 0n,
  policyHash: Array(32).fill(0x11),
  inputHash: Array(32).fill(0x22),
  rationaleHash: Array(32).fill(0x33)
};

const SIG_HEX = 'deadbeef'.repeat(16);

describe('buildVerifiedSupplyTx structural', () => {
  it('builds without throwing', () => {
    expect(() => buildVerifiedSupplyTx(REFS, INTENT, 1_700_000_000_000n, SIG_HEX)).not.toThrow();
  });

  it('produces exactly one MoveCall command', () => {
    const tx = buildVerifiedSupplyTx(REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const commands =
      tx.getData().commands ?? (tx.getData() as { transactions?: unknown[] }).transactions ?? [];
    expect(commands).toHaveLength(1);
  });

  it('MoveCall targets decision::verified_supply_entry', () => {
    const tx = buildVerifiedSupplyTx(REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const commands =
      tx.getData().commands ?? (tx.getData() as { transactions?: unknown[] }).transactions ?? [];
    const cmd = (
      commands as Array<{ MoveCall?: { module: string; function: string; typeArguments: string[] } }>
    )[0];
    expect(cmd?.MoveCall).toBeDefined();
    expect(cmd?.MoveCall?.module).toBe('decision');
    expect(cmd?.MoveCall?.function).toBe('verified_supply_entry');
  });

  it('uses the correct coin type argument', () => {
    const tx = buildVerifiedSupplyTx(REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const commands =
      tx.getData().commands ?? (tx.getData() as { transactions?: unknown[] }).transactions ?? [];
    const cmd = (
      commands as Array<{ MoveCall?: { module: string; function: string; typeArguments: string[] } }>
    )[0];
    expect(cmd?.MoveCall?.typeArguments).toContain(REFS.coinType);
  });

  it('uses default clock 0x6 when clockId is omitted', () => {
    const tx = buildVerifiedSupplyTx(REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const data = tx.getData();
    // tx.object('0x6') produces an UnresolvedObject input in @mysten/sui v2.16
    const inputs = data.inputs as Array<{ UnresolvedObject?: { objectId: string } }>;
    const CLOCK_ID = '0x0000000000000000000000000000000000000000000000000000000000000006';
    const hasClockInput = inputs.some((inp) => inp.UnresolvedObject?.objectId === CLOCK_ID);
    expect(hasClockInput).toBe(true);
  });
});
