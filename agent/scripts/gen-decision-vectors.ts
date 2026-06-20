// Generates secp256k1 test vectors for the Move `decision.move` verify test.
// BCS-encodes the SAME IntentMessage{intent, timestamp_ms, ActionIntent} that
// Move verifies, then signs with a fixed key. `secp256k1.sign` prehashes with
// sha256 by default -- matching Move's `ecdsa_k1::secp256k1_verify(.., 1)`.
//
// Seed of the real enclave signing path. Run: bun run scripts/gen-decision-vectors.ts

import { bcs } from '@mysten/sui/bcs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// --- fixed inputs (MUST match the Move test exactly) ---
const PRIV = hexToBytes('11'.repeat(32)); // deterministic test key
const intent = 0; // DECISION_INTENT
const timestampMs = 1_700_000_000_000n;
const treasury = `0x${'00'.repeat(31)}01`; // @0x1
const agentCap = `0x${'00'.repeat(31)}02`; // @0x2
const amount = 1000n;
const nonce = 7n;

const digest = (byte: number) => Array.from({ length: 32 }, () => byte);

const ActionIntent = bcs.struct('ActionIntent', {
  schema_version: bcs.u16(),
  treasury: bcs.Address,
  agent_cap: bcs.Address,
  nonce: bcs.u64(),
  expires_at_ms: bcs.u64(),
  action_kind: bcs.u8(),
  protocol_id: bcs.u8(),
  coin_type_hash: bcs.vector(bcs.u8()),
  amount: bcs.u64(),
  min_health_factor_bps: bcs.u64(),
  max_protocol_exposure: bcs.u64(),
  policy_hash: bcs.vector(bcs.u8()),
  input_hash: bcs.vector(bcs.u8()),
  report_hash: bcs.vector(bcs.u8()),
  intent_hash: bcs.vector(bcs.u8())
});
const IntentMessage = bcs.struct('IntentMessage', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  payload: ActionIntent
});

const payload = {
  schema_version: 1,
  treasury,
  agent_cap: agentCap,
  nonce,
  expires_at_ms: 1_800_000_000_000n,
  action_kind: 1,
  protocol_id: 2,
  coin_type_hash: digest(0x11),
  amount,
  min_health_factor_bps: 12_500n,
  max_protocol_exposure: 100_000n,
  policy_hash: digest(0x22),
  input_hash: digest(0x33),
  report_hash: digest(0x44),
  intent_hash: digest(0x55)
};

const payloadBytes = ActionIntent.serialize(payload).toBytes();
const msg = IntentMessage.serialize({
  intent,
  timestamp_ms: timestampMs,
  payload
}).toBytes();

const signed = secp256k1.sign(msg, PRIV); // default: sha256 prehash, low-s, compact
const signature = signed instanceof Uint8Array ? signed : (signed as { toBytes(): Uint8Array }).toBytes();
const pk = secp256k1.getPublicKey(PRIV, true); // 33-byte compressed

console.log('action_intent_bcs (hex) =', bytesToHex(payloadBytes), `(${payloadBytes.length} bytes)`);
console.log('msg_bcs (hex)           =', bytesToHex(msg), `(${msg.length} bytes)`);
console.log('pk (hex)                =', bytesToHex(pk), `(${pk.length} bytes)`);
console.log('signature(hex)          =', bytesToHex(signature), `(${signature.length} bytes)`);
