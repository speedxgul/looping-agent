// Generates the canonical ActionIntent BCS bytes + a real secp256k1 signature for
// the fixed test vector, using @mysten/sui/bcs as the authoritative encoder.
// Run: bun run scripts/gen-action-intent-vector.ts
import { bcs } from '@mysten/sui/bcs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const PRIV = hexToBytes('11'.repeat(32));

const ActionIntent = bcs.struct('ActionIntent', {
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
const IntentMessage = bcs.struct('IntentMessage', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  payload: ActionIntent
});

const ascii = (s: string) => Array.from(new TextEncoder().encode(s));

const payload = {
  schema_version: 1,
  chain_id: [0x04],
  treasury_id: `0x${'00'.repeat(31)}01`,
  agent_cap_id: `0x${'00'.repeat(31)}02`,
  nonce: 7n,
  expires_at_ms: 1_700_000_100_000n,
  action_kind: 0,
  protocol_id: 0,
  asset_type: ascii('USDC'),
  amount: 1000n,
  min_health_factor_bps: 0n,
  max_protocol_exposure: 0n,
  policy_hash: Array(32).fill(0x11),
  input_hash: Array(32).fill(0x22),
  rationale_hash: Array(32).fill(0x33)
};

const msg = IntentMessage.serialize({ intent: 0, timestamp_ms: 1_700_000_000_000n, payload }).toBytes();
const sig = secp256k1.sign(msg, PRIV);
const signature = sig instanceof Uint8Array ? sig : (sig as { toBytes(): Uint8Array }).toBytes();
const pk = secp256k1.getPublicKey(PRIV, true);

const payloadBcs = ActionIntent.serialize(payload).toBytes();
console.log('payload_bcs   =', bytesToHex(payloadBcs), `(${payloadBcs.length} bytes)`);
console.log('envelope_bcs  =', bytesToHex(msg), `(${msg.length} bytes)`);
console.log('pk            =', bytesToHex(pk));
console.log('signature     =', bytesToHex(signature));
