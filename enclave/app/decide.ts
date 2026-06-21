import { sha256 } from '@noble/hashes/sha2.js';
import type { AllocationResult, ReserveCurve } from './allocation.ts';
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

/** One signed intent for one allocation leg. */
export interface SignedLeg {
  intent: ActionIntent;
  signature: string;
}

/** Run the strategy INSIDE the enclave and emit ONE signed ActionIntent PER funded
 *  allocation leg — water-filling can split the budget across protocols. Each leg gets a
 *  sequential nonce (`base + i`) so the legs consume in order within a single PTB, and is
 *  capped at the per-tx cap. The whole decision is made here; the agent only relays it. */
export function decide(
  input: DecideInput,
  signingKey: Uint8Array
): { legs: SignedLeg[]; allocation: AllocationResult } {
  // Cap each leg at the per-tx cap (each leg = one `release_for_action`), so no single
  // leg can exceed it. The total stays within `depositRaw` (the agent sizes that to the
  // remaining period budget; the on-chain period cap is the backstop).
  const result = solveAllocation({
    curves: input.curves,
    budgetRaw: input.depositRaw,
    perProtocolCapRaw: input.perTxCapRaw
  });

  const funded = result.allocations.filter((leg) => BigInt(leg.xRaw) > 0n);
  if (funded.length === 0) {
    throw new Error('decide: solveAllocation returned no funded allocation legs');
  }

  // Deterministic input hash: sha256 of the JSON-serialized curves (bigints → strings).
  // Shared by every leg — it commits to the market data that drove the whole decision.
  const inputHash = sha256(
    new TextEncoder().encode(
      JSON.stringify(input.curves, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    )
  );

  const legs: SignedLeg[] = funded.map((leg, i) => {
    const xRaw = BigInt(leg.xRaw);
    const amount = xRaw < input.perTxCapRaw ? xRaw : input.perTxCapRaw;
    const intent: ActionIntent = {
      schemaVersion: 1,
      chainId: Uint8Array.from(input.chainId),
      treasuryId: input.treasuryId,
      agentCapId: input.agentCapId,
      nonce: input.nonce + BigInt(i), // sequential: legs execute in command order in one PTB
      expiresAtMs: input.expiresAtMs,
      actionKind: 0,
      protocolId: PROTOCOL_ID[leg.protocol] ?? 255,
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
  });

  return { legs, allocation: result };
}
