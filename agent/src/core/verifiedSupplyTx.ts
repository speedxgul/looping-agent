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
