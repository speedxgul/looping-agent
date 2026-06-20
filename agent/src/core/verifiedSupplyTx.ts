import { Transaction } from '@mysten/sui/transactions';
import type { ActionIntent } from './actionIntent.js';

export interface VerifiedSupplyRefs {
  packageId: string;
  coinType: string;
  registryId: string;
  treasuryId: string;
  enclaveId: string;
  agentCapId: string;
  clockId?: string;
}

const hexToBytes = (hex: string) =>
  Array.from(Uint8Array.from((hex.match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16))));

/** Build the PTB calling `<pkg>::decision::verified_supply_entry<C>`. */
export function buildVerifiedSupplyTx(
  refs: VerifiedSupplyRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${refs.packageId}::decision::verified_supply_entry`,
    typeArguments: [refs.coinType],
    arguments: [
      tx.object(refs.registryId),
      tx.object(refs.treasuryId),
      tx.object(refs.enclaveId),
      tx.object(refs.agentCapId),
      tx.pure.u16(intent.schemaVersion),
      tx.pure.vector('u8', intent.chainId),
      tx.pure.address(intent.treasuryId),
      tx.pure.address(intent.agentCapId),
      tx.pure.u64(intent.nonce),
      tx.pure.u64(intent.expiresAtMs),
      tx.pure.u8(intent.actionKind),
      tx.pure.u8(intent.protocolId),
      tx.pure.vector('u8', intent.assetType),
      tx.pure.u64(intent.amount),
      tx.pure.u64(intent.minHealthFactorBps),
      tx.pure.u64(intent.maxProtocolExposure),
      tx.pure.vector('u8', intent.policyHash),
      tx.pure.vector('u8', intent.inputHash),
      tx.pure.vector('u8', intent.rationaleHash),
      tx.pure.u64(timestampMs),
      tx.pure.vector('u8', hexToBytes(signatureHex)),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  return tx;
}

export interface VerifiedSupplySuilendRefs extends VerifiedSupplyRefs {
  /** Suilend lending-market type `P` (e.g. mainnet `0x…::suilend::MAIN_POOL`). */
  marketType: string;
  /** The shared `LendingMarket<P>` object id. */
  lendingMarketId: string;
  /** Reserve index for the asset, resolved off-chain from the coin type. */
  reserveArrayIndex: bigint;
}

/**
 * Build the PTB calling `<pkg>::decision::verified_supply_suilend_entry<P, C>`.
 * Same signed-intent args as `buildVerifiedSupplyTx`, with the `LendingMarket<P>` +
 * `reserve_array_index` inserted right after `cap` (they are PTB args, NOT part of the
 * signed intent). Type args are `[marketType (P), coinType (C)]`.
 */
export function buildVerifiedSupplySuilendTx(
  refs: VerifiedSupplySuilendRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${refs.packageId}::decision::verified_supply_suilend_entry`,
    typeArguments: [refs.marketType, refs.coinType],
    arguments: [
      tx.object(refs.registryId),
      tx.object(refs.treasuryId),
      tx.object(refs.enclaveId),
      tx.object(refs.agentCapId),
      tx.object(refs.lendingMarketId),
      tx.pure.u64(refs.reserveArrayIndex),
      tx.pure.u16(intent.schemaVersion),
      tx.pure.vector('u8', intent.chainId),
      tx.pure.address(intent.treasuryId),
      tx.pure.address(intent.agentCapId),
      tx.pure.u64(intent.nonce),
      tx.pure.u64(intent.expiresAtMs),
      tx.pure.u8(intent.actionKind),
      tx.pure.u8(intent.protocolId),
      tx.pure.vector('u8', intent.assetType),
      tx.pure.u64(intent.amount),
      tx.pure.u64(intent.minHealthFactorBps),
      tx.pure.u64(intent.maxProtocolExposure),
      tx.pure.vector('u8', intent.policyHash),
      tx.pure.vector('u8', intent.inputHash),
      tx.pure.vector('u8', intent.rationaleHash),
      tx.pure.u64(timestampMs),
      tx.pure.vector('u8', hexToBytes(signatureHex)),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  return tx;
}

export interface VerifiedSupplyScallopRefs extends VerifiedSupplyRefs {
  /** Scallop's shared `Version` guard object id. */
  versionId: string;
  /** Scallop's shared `Market` object id. */
  marketId: string;
}

/**
 * Build the PTB calling `<pkg>::decision::verified_supply_scallop_entry<C>`. Same signed
 * intent args as `buildVerifiedSupplyTx`, with Scallop's shared `Version` + `Market`
 * inserted right after `cap`. Single type arg `[coinType (C)]` (Scallop's `mint`/`redeem`
 * are parameterized only by the underlying coin).
 */
export function buildVerifiedSupplyScallopTx(
  refs: VerifiedSupplyScallopRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${refs.packageId}::decision::verified_supply_scallop_entry`,
    typeArguments: [refs.coinType],
    arguments: [
      tx.object(refs.registryId),
      tx.object(refs.treasuryId),
      tx.object(refs.enclaveId),
      tx.object(refs.agentCapId),
      tx.object(refs.versionId),
      tx.object(refs.marketId),
      tx.pure.u16(intent.schemaVersion),
      tx.pure.vector('u8', intent.chainId),
      tx.pure.address(intent.treasuryId),
      tx.pure.address(intent.agentCapId),
      tx.pure.u64(intent.nonce),
      tx.pure.u64(intent.expiresAtMs),
      tx.pure.u8(intent.actionKind),
      tx.pure.u8(intent.protocolId),
      tx.pure.vector('u8', intent.assetType),
      tx.pure.u64(intent.amount),
      tx.pure.u64(intent.minHealthFactorBps),
      tx.pure.u64(intent.maxProtocolExposure),
      tx.pure.vector('u8', intent.policyHash),
      tx.pure.vector('u8', intent.inputHash),
      tx.pure.vector('u8', intent.rationaleHash),
      tx.pure.u64(timestampMs),
      tx.pure.vector('u8', hexToBytes(signatureHex)),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  return tx;
}

export interface VerifiedSupplyNaviRefs extends VerifiedSupplyRefs {
  /** NAVI's shared `Storage` object id. */
  storageId: string;
  /** NAVI's shared `Pool<C>` object id for the asset. */
  poolId: string;
  /** NAVI's shared `incentive_v2::Incentive` object id. */
  incentiveV2Id: string;
  /** NAVI's shared `incentive_v3::Incentive` object id. */
  incentiveV3Id: string;
  /** NAVI asset/reserve index (u8). */
  assetId: number;
}

/**
 * Build the PTB calling `<pkg>::decision::verified_supply_navi_entry<C>`. Same signed
 * intent args as `buildVerifiedSupplyTx`, with NAVI's shared `Storage` / `Pool<C>` /
 * `Incentive` (v2+v3) objects + the `asset` index inserted right after `cap`. Single type
 * arg `[coinType (C)]` — 27 args total (5 more than the mock entry).
 */
export function buildVerifiedSupplyNaviTx(
  refs: VerifiedSupplyNaviRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${refs.packageId}::decision::verified_supply_navi_entry`,
    typeArguments: [refs.coinType],
    arguments: [
      tx.object(refs.registryId),
      tx.object(refs.treasuryId),
      tx.object(refs.enclaveId),
      tx.object(refs.agentCapId),
      tx.object(refs.storageId),
      tx.object(refs.poolId),
      tx.object(refs.incentiveV2Id),
      tx.object(refs.incentiveV3Id),
      tx.pure.u8(refs.assetId),
      tx.pure.u16(intent.schemaVersion),
      tx.pure.vector('u8', intent.chainId),
      tx.pure.address(intent.treasuryId),
      tx.pure.address(intent.agentCapId),
      tx.pure.u64(intent.nonce),
      tx.pure.u64(intent.expiresAtMs),
      tx.pure.u8(intent.actionKind),
      tx.pure.u8(intent.protocolId),
      tx.pure.vector('u8', intent.assetType),
      tx.pure.u64(intent.amount),
      tx.pure.u64(intent.minHealthFactorBps),
      tx.pure.u64(intent.maxProtocolExposure),
      tx.pure.vector('u8', intent.policyHash),
      tx.pure.vector('u8', intent.inputHash),
      tx.pure.vector('u8', intent.rationaleHash),
      tx.pure.u64(timestampMs),
      tx.pure.vector('u8', hexToBytes(signatureHex)),
      tx.object(refs.clockId ?? '0x6')
    ]
  });
  return tx;
}
