import { sha256 } from '@noble/hashes/sha2.js';
import type { ReserveCurve } from './allocation.ts';
import { solveAllocation } from './allocation.ts';
import { type ActionIntent, signActionIntent } from './action_intent.ts';

const PROTOCOL_ID: Record<string, number> = { suilend: 0, scallop: 1, navi: 2, mock: 255 };

export interface DecideInput {
  curves: ReserveCurve[];
  depositRaw: bigint;
  treasuryId: string;
  agentCapId: string;
  perTxCapRaw: bigint;
  nonce: bigint;
  expiresAtMs: bigint;
  /** Chain ID bytes, e.g. [0x04] for Sui mainnet. */
  assetType: number[];
  chainId: number[];
  timestampMs: bigint;
}

/** Run the strategy INSIDE the enclave and emit ONE signed, bounds-respecting
 *  ActionIntent for the top allocation leg. The decision is made here. */
export function decide(input: DecideInput, signingKey: Uint8Array): { intent: ActionIntent; signature: string } {
  const result = solveAllocation({
    curves: input.curves,
    budgetRaw: input.depositRaw
  });

  // Pick the leg with the largest share (primary allocation target).
  const top = result.allocations.slice().sort((a, b) => b.share - a.share)[0];

  if (!top) {
    throw new Error('decide: solveAllocation returned no allocation legs');
  }

  // Clamp to the per-tx cap.
  const xRaw = BigInt(top.xRaw);
  const amount = xRaw < input.perTxCapRaw ? xRaw : input.perTxCapRaw;

  // Deterministic input hash: sha256 of the JSON-serialized curves (bigints → strings).
  const inputHash = sha256(
    new TextEncoder().encode(
      JSON.stringify(input.curves, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    )
  );

  const intent: ActionIntent = {
    schemaVersion: 1,
    chainId: Uint8Array.from(input.chainId),
    treasuryId: input.treasuryId,
    agentCapId: input.agentCapId,
    nonce: input.nonce,
    expiresAtMs: input.expiresAtMs,
    actionKind: 0,
    protocolId: PROTOCOL_ID[top.protocol] ?? 255,
    assetType: Uint8Array.from(input.assetType),
    amount,
    minHealthFactorBps: 0n,
    maxProtocolExposure: 0n,
    policyHash: new Uint8Array(32).fill(0),
    inputHash,
    rationaleHash: new Uint8Array(32).fill(0)
  };

  const { signature } = signActionIntent(intent, input.timestampMs, signingKey);
  return { intent, signature };
}
