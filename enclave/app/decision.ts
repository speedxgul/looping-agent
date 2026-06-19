// Decision codec + signer for the enclave.
//
// Encodes the SAME BCS envelope that `move/sources/decision.move` verifies:
//   IntentMessage = intent:u8 ++ timestamp_ms:u64(LE) ++ DecisionPayload
//   DecisionPayload = treasury:32 bytes ++ amount:u64(LE) ++ nonce:u64(LE)
// then secp256k1-signs sha256(envelope) — matching `ecdsa_k1::secp256k1_verify(.., 1)`.
//
// BCS for fixed-width ints is just little-endian, so we hand-roll it to keep the
// enclave dependency surface minimal (only @noble) for a small, reproducible PCR.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const DECISION_INTENT = 0;

export interface Decision {
  treasury: string; // 0x… Sui object id (32 bytes)
  amount: bigint;
  nonce: bigint;
  timestampMs: bigint;
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

function address32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').padStart(64, '0');
  if (clean.length !== 64) throw new Error(`bad address length: ${hex}`);
  return hexToBytes(clean);
}

/** The exact bytes the enclave signs and Move re-derives. */
export function encodeEnvelope(d: Decision): Uint8Array {
  return Uint8Array.from([
    DECISION_INTENT,
    ...u64le(d.timestampMs),
    ...address32(d.treasury),
    ...u64le(d.amount),
    ...u64le(d.nonce)
  ]);
}

/** Sign a decision. `secp256k1.sign` prehashes with sha256 by default (matches Move). */
export function signDecision(d: Decision, privKey: Uint8Array): { payload: Decision; signature: string } {
  const msg = encodeEnvelope(d);
  const sig = secp256k1.sign(msg, privKey);
  const signature = sig instanceof Uint8Array ? sig : (sig as { toBytes(): Uint8Array }).toBytes();
  return { payload: d, signature: bytesToHex(signature) };
}

export function publicKeyHex(privKey: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(privKey, true)); // 33-byte compressed
}

// Parity self-test: the fixed vector below is what move/sources/decision.move's
// `verify_real_enclave_signature` test accepts. If this throws, the enclave's BCS
// or signing has drifted from the on-chain verifier — fail loud at startup.
const SELF_TEST = {
  priv: '11'.repeat(32),
  decision: { treasury: '0x1', amount: 1000n, nonce: 7n, timestampMs: 1_700_000_000_000n } as Decision,
  envelope: '000068e5cf8b0100000000000000000000000000000000000000000000000000000000000000000001e8030000000000000700000000000000',
  pk: '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
  signature: 'f02f7e72ff9eae4a8762df11bff89ff9e1cb2c87f734b3958f650cc031baec532bb1f6e8b62f3a7f185bd9ce5b2f9d0807b90e6b5f62ac8f2eed63d4dd92dea4'
};

export function runSelfTest(): void {
  const priv = hexToBytes(SELF_TEST.priv);
  const env = bytesToHex(encodeEnvelope(SELF_TEST.decision));
  if (env !== SELF_TEST.envelope) {
    throw new Error(`BCS envelope drift!\n  got ${env}\n  exp ${SELF_TEST.envelope}`);
  }
  if (publicKeyHex(priv) !== SELF_TEST.pk) throw new Error('public key drift');
  if (signDecision(SELF_TEST.decision, priv).signature !== SELF_TEST.signature) {
    throw new Error('signature drift from the on-chain-verified vector');
  }
}
