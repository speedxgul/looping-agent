import { describe, expect, it } from 'bun:test';
import {
  buildOwnerRedeemMockTx,
  buildOwnerRedeemNaviTx,
  buildOwnerRedeemScallopTx,
  buildOwnerRedeemSuilendTx,
  type OwnerRedeemRefs
} from '../src/core/ownerRedeemTx.js';

const A = (n: number) => `0x${String(n).padStart(64, '0')}`;

const base: OwnerRedeemRefs = {
  packageId: A(99),
  coinType: '0x2::sui::SUI',
  treasuryId: A(1),
  ownerCapId: A(2),
  ownerAddress: A(3)
};

// biome-ignore lint/suspicious/noExplicitAny: introspecting the built transaction
const commandsOf = (tx: any) =>
  tx.getData().commands as Array<{
    MoveCall?: { module: string; function: string; typeArguments: string[]; arguments: unknown[] };
    TransferObjects?: unknown;
  }>;

describe('owner-redeem (withdraw) builders', () => {
  it('mock: mock_supply::owner_redeem, 2 args, then transfers the coin to the owner', () => {
    const cmds = commandsOf(buildOwnerRedeemMockTx(base));
    expect(cmds[0]?.MoveCall?.module).toBe('mock_supply');
    expect(cmds[0]?.MoveCall?.function).toBe('owner_redeem');
    expect(cmds[0]?.MoveCall?.typeArguments).toEqual([base.coinType]);
    expect(cmds[0]?.MoveCall?.arguments).toHaveLength(2); // treasury, ownerCap
    expect(cmds[1]?.TransferObjects).toBeDefined(); // recovered coin -> owner
  });

  it('suilend: type args [P, C], 6 args (+ lending_market, reserve_idx, amount, clock)', () => {
    const cmds = commandsOf(
      buildOwnerRedeemSuilendTx({
        ...base,
        marketType: `${A(15)}::suilend::MAIN_POOL`,
        lendingMarketId: A(4),
        reserveArrayIndex: 3n,
        amount: 100n
      })
    );
    expect(cmds[0]?.MoveCall?.module).toBe('suilend_adapter');
    expect(cmds[0]?.MoveCall?.typeArguments).toHaveLength(2);
    expect(cmds[0]?.MoveCall?.arguments).toHaveLength(6);
    expect(cmds[1]?.TransferObjects).toBeDefined();
  });

  it('scallop: type arg [C], 5 args (+ version, market, clock), whole-position redeem', () => {
    const cmds = commandsOf(buildOwnerRedeemScallopTx({ ...base, versionId: A(5), marketId: A(6) }));
    expect(cmds[0]?.MoveCall?.module).toBe('scallop_adapter');
    expect(cmds[0]?.MoveCall?.typeArguments).toEqual([base.coinType]);
    expect(cmds[0]?.MoveCall?.arguments).toHaveLength(5);
  });

  it('navi: type arg [C], 10 args (+ oracle, storage, pool, inc×2, asset, amount, clock)', () => {
    const cmds = commandsOf(
      buildOwnerRedeemNaviTx({
        ...base,
        oracleId: A(7),
        storageId: A(8),
        poolId: A(9),
        incentiveV2Id: A(10),
        incentiveV3Id: A(11),
        assetId: 5,
        amount: 100n
      })
    );
    expect(cmds[0]?.MoveCall?.module).toBe('navi_adapter');
    expect(cmds[0]?.MoveCall?.arguments).toHaveLength(10);
    expect(cmds[1]?.TransferObjects).toBeDefined();
  });
});
