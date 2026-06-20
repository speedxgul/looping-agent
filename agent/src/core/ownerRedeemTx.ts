import { Transaction } from '@mysten/sui/transactions';

// OWNER-side withdrawal builders. Unlike supply, `owner_redeem` is OwnerCap-gated and
// does NOT go through the enclave — the owner has direct authority. Each adapter's
// `owner_redeem` takes the custodied receipt out (owner-only), withdraws from the
// protocol, and returns a `Coin<T>` that we transfer back to the owner.
//
// ⚠️ LIVE Suilend / NAVI withdraw additionally need a fresh oracle price: a Pyth
// `refresh_reserve_price` (Suilend) / `update_oracle_price` (NAVI) command must be
// prepended in the SAME PTB before `owner_redeem`, or the protocol aborts on a stale
// price. Mock + Scallop need no oracle. The refresh composition is not built here yet.

export interface OwnerRedeemRefs {
  packageId: string;
  coinType: string;
  treasuryId: string;
  ownerCapId: string;
  /** Where the recovered Coin<T> is sent (the owner). */
  ownerAddress: string;
  clockId?: string;
}

function transferToOwner(tx: Transaction, coin: ReturnType<Transaction['moveCall']>, ownerAddress: string) {
  tx.transferObjects([coin], tx.pure.address(ownerAddress));
}

/** `mock_supply::owner_redeem<T>(treasury, owner)` → Coin<T> to the owner. */
export function buildOwnerRedeemMockTx(refs: OwnerRedeemRefs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${refs.packageId}::mock_supply::owner_redeem`,
    typeArguments: [refs.coinType],
    arguments: [tx.object(refs.treasuryId), tx.object(refs.ownerCapId)]
  });
  transferToOwner(tx, coin, refs.ownerAddress);
  return tx;
}

export interface OwnerRedeemSuilendRefs extends OwnerRedeemRefs {
  marketType: string;
  lendingMarketId: string;
  reserveArrayIndex: bigint;
  /** cTokens to withdraw (in cToken units). */
  amount: bigint;
}

/** `suilend_adapter::owner_redeem<P,T>(treasury, owner, lending_market, reserve_idx, amount, clock)`. */
export function buildOwnerRedeemSuilendTx(refs: OwnerRedeemSuilendRefs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${refs.packageId}::suilend_adapter::owner_redeem`,
    typeArguments: [refs.marketType, refs.coinType],
    arguments: [
      tx.object(refs.treasuryId),
      tx.object(refs.ownerCapId),
      tx.object(refs.lendingMarketId),
      tx.pure.u64(refs.reserveArrayIndex),
      tx.pure.u64(refs.amount),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  transferToOwner(tx, coin, refs.ownerAddress);
  return tx;
}

export interface OwnerRedeemScallopRefs extends OwnerRedeemRefs {
  versionId: string;
  marketId: string;
}

/** `scallop_adapter::owner_redeem<T>(treasury, owner, version, market, clock)` — redeems the whole position. */
export function buildOwnerRedeemScallopTx(refs: OwnerRedeemScallopRefs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${refs.packageId}::scallop_adapter::owner_redeem`,
    typeArguments: [refs.coinType],
    arguments: [
      tx.object(refs.treasuryId),
      tx.object(refs.ownerCapId),
      tx.object(refs.versionId),
      tx.object(refs.marketId),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  transferToOwner(tx, coin, refs.ownerAddress);
  return tx;
}

export interface OwnerRedeemNaviRefs extends OwnerRedeemRefs {
  /** NAVI's shared `PriceOracle` (must be refreshed in the same PTB for a live run). */
  oracleId: string;
  storageId: string;
  poolId: string;
  incentiveV2Id: string;
  incentiveV3Id: string;
  assetId: number;
  amount: bigint;
}

/** `navi_adapter::owner_redeem<T>(treasury, owner, oracle, storage, pool, inc_v2, inc_v3, asset, amount, clock)`. */
export function buildOwnerRedeemNaviTx(refs: OwnerRedeemNaviRefs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${refs.packageId}::navi_adapter::owner_redeem`,
    typeArguments: [refs.coinType],
    arguments: [
      tx.object(refs.treasuryId),
      tx.object(refs.ownerCapId),
      tx.object(refs.oracleId),
      tx.object(refs.storageId),
      tx.object(refs.poolId),
      tx.object(refs.incentiveV2Id),
      tx.object(refs.incentiveV3Id),
      tx.pure.u8(refs.assetId),
      tx.pure.u64(refs.amount),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  transferToOwner(tx, coin, refs.ownerAddress);
  return tx;
}
