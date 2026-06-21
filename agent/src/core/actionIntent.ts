import { bcs } from '@mysten/sui/bcs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const DECISION_INTENT = 0;

export interface ActionIntent {
  schemaVersion: number;
  chainId: number[];
  treasuryId: string;
  agentCapId: string;
  nonce: bigint;
  expiresAtMs: bigint;
  actionKind: number;
  protocolId: number;
  assetType: number[];
  amount: bigint;
  minHealthFactorBps: bigint;
  maxProtocolExposure: bigint;
  policyHash: number[];
  inputHash: number[];
  rationaleHash: number[];
}

const ActionIntentBcs = bcs.struct('ActionIntent', {
  schema_version: bcs.u16(),
  chain_id: bcs.vector(bcs.u8()),
  treasury_id: bcs.Address,
  agent_cap_id: bcs.Address,
  nonce: bcs.u64(),
  expires_at_ms: bcs.u64(),
  action_kind: bcs.u8(),
  protocol_id: bcs.u8(),
  asset_type: bcs.vector(bcs.u8()),
  amount: bcs.u64(),
  min_health_factor_bps: bcs.u64(),
  max_protocol_exposure: bcs.u64(),
  policy_hash: bcs.vector(bcs.u8()),
  input_hash: bcs.vector(bcs.u8()),
  rationale_hash: bcs.vector(bcs.u8())
});
const IntentMessageBcs = bcs.struct('IntentMessage', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  payload: ActionIntentBcs
});

function toBcs(a: ActionIntent) {
  return {
    schema_version: a.schemaVersion,
    chain_id: a.chainId,
    treasury_id: a.treasuryId,
    agent_cap_id: a.agentCapId,
    nonce: a.nonce,
    expires_at_ms: a.expiresAtMs,
    action_kind: a.actionKind,
    protocol_id: a.protocolId,
    asset_type: a.assetType,
    amount: a.amount,
    min_health_factor_bps: a.minHealthFactorBps,
    max_protocol_exposure: a.maxProtocolExposure,
    policy_hash: a.policyHash,
    input_hash: a.inputHash,
    rationale_hash: a.rationaleHash
  };
}

export function encodePayload(a: ActionIntent): Uint8Array {
  return ActionIntentBcs.serialize(toBcs(a)).toBytes();
}
export function encodeEnvelope(a: ActionIntent, timestampMs: bigint): Uint8Array {
  return IntentMessageBcs.serialize({
    intent: DECISION_INTENT,
    timestamp_ms: timestampMs,
    payload: toBcs(a)
  }).toBytes();
}
export function signActionIntent(a: ActionIntent, timestampMs: bigint, priv: Uint8Array): string {
  const sig = secp256k1.sign(encodeEnvelope(a, timestampMs), priv);
  const bytes = sig instanceof Uint8Array ? sig : (sig as { toBytes(): Uint8Array }).toBytes();
  return bytesToHex(bytes);
}
