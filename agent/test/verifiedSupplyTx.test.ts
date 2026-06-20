import { describe, expect, it } from 'bun:test';
import type { ActionIntent } from '../src/core/actionIntent.js';
import {
  buildVerifiedSupplyNaviTx,
  buildVerifiedSupplyScallopTx,
  buildVerifiedSupplySuilendTx,
  buildVerifiedSupplyTx,
  type VerifiedSupplyNaviRefs,
  type VerifiedSupplyRefs,
  type VerifiedSupplyScallopRefs,
  type VerifiedSupplySuilendRefs
} from '../src/core/verifiedSupplyTx.js';

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

const SUILEND_REFS: VerifiedSupplySuilendRefs = {
  ...REFS,
  marketType: `0x${'0f'.repeat(32)}::suilend::MAIN_POOL`,
  lendingMarketId: `0x${'05'.repeat(32)}`,
  reserveArrayIndex: 3n
};

const SCALLOP_REFS: VerifiedSupplyScallopRefs = {
  ...REFS,
  versionId: `0x${'06'.repeat(32)}`,
  marketId: `0x${'07'.repeat(32)}`
};

const NAVI_REFS: VerifiedSupplyNaviRefs = {
  ...REFS,
  storageId: `0x${'08'.repeat(32)}`,
  poolId: `0x${'09'.repeat(32)}`,
  incentiveV2Id: `0x${'0a'.repeat(32)}`,
  incentiveV3Id: `0x${'0b'.repeat(32)}`,
  assetId: 5
};

const commandsOf = (tx: ReturnType<typeof buildVerifiedSupplyTx>) =>
  (tx.getData().commands ?? (tx.getData() as { transactions?: unknown[] }).transactions ?? []) as Array<{
    MoveCall?: { module: string; function: string; typeArguments: string[]; arguments: unknown[] };
  }>;

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

describe('buildVerifiedSupplySuilendTx structural', () => {
  it('MoveCall targets decision::verified_supply_suilend_entry', () => {
    const tx = buildVerifiedSupplySuilendTx(SUILEND_REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const cmd = commandsOf(tx)[0];
    expect(cmd?.MoveCall?.module).toBe('decision');
    expect(cmd?.MoveCall?.function).toBe('verified_supply_suilend_entry');
  });

  it('passes type args [marketType (P), coinType (C)] in order', () => {
    const tx = buildVerifiedSupplySuilendTx(SUILEND_REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    expect(commandsOf(tx)[0]?.MoveCall?.typeArguments).toEqual([SUILEND_REFS.marketType, REFS.coinType]);
  });

  it('inserts LendingMarket + reserve_array_index after cap (2 args more than the mock entry)', () => {
    const suilend = commandsOf(buildVerifiedSupplySuilendTx(SUILEND_REFS, INTENT, 1n, SIG_HEX))[0];
    const mock = commandsOf(buildVerifiedSupplyTx(REFS, INTENT, 1n, SIG_HEX))[0];
    expect(suilend?.MoveCall?.arguments).toHaveLength(24);
    expect(mock?.MoveCall?.arguments).toHaveLength(22);
  });
});

describe('buildVerifiedSupplyScallopTx structural', () => {
  it('MoveCall targets decision::verified_supply_scallop_entry', () => {
    const tx = buildVerifiedSupplyScallopTx(SCALLOP_REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const cmd = commandsOf(tx)[0];
    expect(cmd?.MoveCall?.module).toBe('decision');
    expect(cmd?.MoveCall?.function).toBe('verified_supply_scallop_entry');
  });

  it('uses a single type arg [coinType (C)]', () => {
    const tx = buildVerifiedSupplyScallopTx(SCALLOP_REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    expect(commandsOf(tx)[0]?.MoveCall?.typeArguments).toEqual([REFS.coinType]);
  });

  it('inserts Version + Market after cap (24 args, 2 more than the mock entry)', () => {
    const scallop = commandsOf(buildVerifiedSupplyScallopTx(SCALLOP_REFS, INTENT, 1n, SIG_HEX))[0];
    const mock = commandsOf(buildVerifiedSupplyTx(REFS, INTENT, 1n, SIG_HEX))[0];
    expect(scallop?.MoveCall?.arguments).toHaveLength(24);
    expect(mock?.MoveCall?.arguments).toHaveLength(22);
  });
});

describe('buildVerifiedSupplyNaviTx structural', () => {
  it('MoveCall targets decision::verified_supply_navi_entry', () => {
    const tx = buildVerifiedSupplyNaviTx(NAVI_REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    const cmd = commandsOf(tx)[0];
    expect(cmd?.MoveCall?.module).toBe('decision');
    expect(cmd?.MoveCall?.function).toBe('verified_supply_navi_entry');
  });

  it('uses a single type arg [coinType (C)]', () => {
    const tx = buildVerifiedSupplyNaviTx(NAVI_REFS, INTENT, 1_700_000_000_000n, SIG_HEX);
    expect(commandsOf(tx)[0]?.MoveCall?.typeArguments).toEqual([REFS.coinType]);
  });

  it('inserts Storage + Pool + Incentive(v2,v3) + asset after cap (27 args, 5 more than the mock entry)', () => {
    const navi = commandsOf(buildVerifiedSupplyNaviTx(NAVI_REFS, INTENT, 1n, SIG_HEX))[0];
    const mock = commandsOf(buildVerifiedSupplyTx(REFS, INTENT, 1n, SIG_HEX))[0];
    expect(navi?.MoveCall?.arguments).toHaveLength(27);
    expect(mock?.MoveCall?.arguments).toHaveLength(22);
  });
});
