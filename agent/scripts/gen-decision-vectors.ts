// Generates secp256k1 test vectors for the Move `decision.move` verify test.
// BCS-encodes the SAME IntentMessage{intent, timestamp_ms, DecisionPayload} that
// Move verifies, then signs with a fixed key. `secp256k1.sign` prehashes with
// sha256 by default — matching Move's `ecdsa_k1::secp256k1_verify(.., 1)`.
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
const amount = 1000n;
const nonce = 7n;

const DecisionPayload = bcs.struct('DecisionPayload', {
  treasury: bcs.Address,
  amount: bcs.u64(),
  nonce: bcs.u64()
});
const IntentMessage = bcs.struct('IntentMessage', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  payload: DecisionPayload
});

const msg = IntentMessage.serialize({
  intent,
  timestamp_ms: timestampMs,
  payload: { treasury, amount, nonce }
}).toBytes();

const signed = secp256k1.sign(msg, PRIV); // default: sha256 prehash, low-s, compact
const signature = signed instanceof Uint8Array ? signed : (signed as { toBytes(): Uint8Array }).toBytes();
const pk = secp256k1.getPublicKey(PRIV, true); // 33-byte compressed

console.log('msg_bcs (hex) =', bytesToHex(msg), `(${msg.length} bytes)`);
console.log('pk (hex)      =', bytesToHex(pk), `(${pk.length} bytes)`);
console.log('signature(hex)=', bytesToHex(signature), `(${signature.length} bytes)`);
