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

/** The trailing args shared by every entry: the 15 signed ActionIntent fields, the
 *  timestamp the enclave signed, the signature, and the Clock. */
function intentTail(
  tx: Transaction,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string,
  clockId?: string
) {
  return [
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
    tx.object(clockId ?? '0x6')
  ];
}

// --- Per-protocol "append one command to a (possibly shared) PTB" helpers ---
// These are what `buildVerifiedAllocationTx` uses to put several legs in one transaction.

function addMockCall(
  tx: Transaction,
  refs: VerifiedSupplyRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  sig: string
) {
  tx.moveCall({
    target: `${refs.packageId}::decision::verified_supply_entry`,
    typeArguments: [refs.coinType],
    arguments: [
      tx.object(refs.registryId),
      tx.object(refs.treasuryId),
      tx.object(refs.enclaveId),
      tx.object(refs.agentCapId),
      ...intentTail(tx, intent, timestampMs, sig, refs.clockId)
    ]
  });
}

export interface VerifiedSupplySuilendRefs extends VerifiedSupplyRefs {
  /** Suilend lending-market type `P` (e.g. mainnet `0x…::suilend::MAIN_POOL`). */
  marketType: string;
  /** The shared `LendingMarket<P>` object id. */
  lendingMarketId: string;
  /** Reserve index for the asset, resolved off-chain from the coin type. */
  reserveArrayIndex: bigint;
  /** The on-chain Pyth `PriceInfoObject` id for this reserve's asset. Present →
   *  a reserve-price refresh is prepended to the supply PTB (Suilend deposit aborts
   *  on a stale reserve price). Absent (e.g. testnet/mock-only) → no refresh. */
  pythPriceInfoObjectId?: string;
}

function addSuilendCall(
  tx: Transaction,
  refs: VerifiedSupplySuilendRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  sig: string
) {
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
      ...intentTail(tx, intent, timestampMs, sig, refs.clockId)
    ]
  });
}

export interface VerifiedSupplyScallopRefs extends VerifiedSupplyRefs {
  /** Scallop's shared `Version` guard object id. */
  versionId: string;
  /** Scallop's shared `Market` object id. */
  marketId: string;
}

function addScallopCall(
  tx: Transaction,
  refs: VerifiedSupplyScallopRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  sig: string
) {
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
      ...intentTail(tx, intent, timestampMs, sig, refs.clockId)
    ]
  });
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

function addNaviCall(
  tx: Transaction,
  refs: VerifiedSupplyNaviRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  sig: string
) {
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
      ...intentTail(tx, intent, timestampMs, sig, refs.clockId)
    ]
  });
}

// --- Single-protocol builders (one command per tx) ---

/** Build the PTB calling `<pkg>::decision::verified_supply_entry<C>` (mock adapter). */
export function buildVerifiedSupplyTx(
  refs: VerifiedSupplyRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  addMockCall(tx, refs, intent, timestampMs, signatureHex);
  return tx;
}

/** Build the PTB calling `verified_supply_suilend_entry<P, C>` (LendingMarket + reserve index after cap). */
export function buildVerifiedSupplySuilendTx(
  refs: VerifiedSupplySuilendRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  addSuilendCall(tx, refs, intent, timestampMs, signatureHex);
  return tx;
}

/** Build the PTB calling `verified_supply_scallop_entry<C>` (Version + Market after cap). */
export function buildVerifiedSupplyScallopTx(
  refs: VerifiedSupplyScallopRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  addScallopCall(tx, refs, intent, timestampMs, signatureHex);
  return tx;
}

/** Build the PTB calling `verified_supply_navi_entry<C>` (Storage/Pool/Incentive×2 + asset after cap). */
export function buildVerifiedSupplyNaviTx(
  refs: VerifiedSupplyNaviRefs,
  intent: ActionIntent,
  timestampMs: bigint,
  signatureHex: string
): Transaction {
  const tx = new Transaction();
  addNaviCall(tx, refs, intent, timestampMs, signatureHex);
  return tx;
}

// --- Multi-leg allocation: one PTB, one command per leg ---

/** A single leg returned by the enclave's `/decide`: the parsed intent + its signature. */
export interface AllocationLeg {
  intent: ActionIntent;
  signatureHex: string;
}

/** Per-protocol refs, supplied for whichever protocols appear in the legs. */
export interface AllocationRefs {
  suilend?: VerifiedSupplySuilendRefs;
  scallop?: VerifiedSupplyScallopRefs;
  navi?: VerifiedSupplyNaviRefs;
  mock?: VerifiedSupplyRefs;
}

/**
 * Bundle a multi-protocol water-filling allocation into ONE PTB — one `verified_supply_*`
 * command per leg, routed by `intent.protocolId` (suilend 0, scallop 1, navi 2, mock 255).
 * The legs MUST be ordered by ascending nonce (as the enclave emits them): PTB commands
 * execute in order, so the on-chain `consume_nonce` (strictly increasing per treasury) is
 * satisfied. The whole allocation is atomic — if any leg aborts, the transaction reverts.
 * `timestampMs` is the timestamp the enclave signed every leg with.
 */
export function buildVerifiedAllocationTx(
  legs: AllocationLeg[],
  refs: AllocationRefs,
  timestampMs: bigint,
  tx: Transaction = new Transaction()
): Transaction {
  for (const { intent, signatureHex } of legs) {
    switch (intent.protocolId) {
      case 0:
        if (!refs.suilend) throw new Error('allocation has a Suilend leg but no suilend refs');
        addSuilendCall(tx, refs.suilend, intent, timestampMs, signatureHex);
        break;
      case 1:
        if (!refs.scallop) throw new Error('allocation has a Scallop leg but no scallop refs');
        addScallopCall(tx, refs.scallop, intent, timestampMs, signatureHex);
        break;
      case 2:
        if (!refs.navi) throw new Error('allocation has a NAVI leg but no navi refs');
        addNaviCall(tx, refs.navi, intent, timestampMs, signatureHex);
        break;
      case 255:
        if (!refs.mock) throw new Error('allocation has a mock leg but no mock refs');
        addMockCall(tx, refs.mock, intent, timestampMs, signatureHex);
        break;
      default:
        throw new Error(`allocation leg has unsupported protocolId ${intent.protocolId}`);
    }
  }
  return tx;
}
