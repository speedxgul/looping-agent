// ActionIntent codec + signer for the enclave.
//
// Encodes the SAME BCS envelope that `move/sources/decision.move` verifies:
//   IntentMessage = intent:u8 ++ timestamp_ms:u64(LE) ++ ActionIntent
// then secp256k1-signs sha256(envelope), matching
// `ecdsa_k1::secp256k1_verify(.., 1)`.
//
// BCS for this fixed schema is simple enough to hand-roll. That keeps the enclave
// dependency surface minimal for reproducible PCRs.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const DECISION_INTENT = 0;
export const ACTION_SUPPLY = 1;
export const PROTOCOL_SUILEND = 1;
export const PROTOCOL_NAVI = 2;
export const PROTOCOL_SCALLOP = 3;

export interface ActionIntent {
  schemaVersion: number;
  treasury: string; // 0x... Sui object id (32 bytes)
  agentCap: string; // 0x... Sui object id (32 bytes)
  nonce: bigint;
  expiresAtMs: bigint;
  actionKind: number;
  protocolId: number;
  coinTypeHash: Uint8Array;
  amount: bigint;
  minHealthFactorBps: bigint;
  maxProtocolExposure: bigint;
  policyHash: Uint8Array;
  inputHash: Uint8Array;
  reportHash: Uint8Array;
  intentHash: Uint8Array;
}

export interface SignedActionIntent {
  intent: ActionIntent;
  timestampMs: bigint;
}

function u8(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`bad u8: ${v}`);
  return Uint8Array.of(v);
}

function u16le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`bad u16: ${v}`);
  return Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`bad u64: ${v}`);
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

function vectorU8(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 127) {
    throw new Error('vectorU8 only supports single-byte ULEB128 lengths in this enclave schema');
  }
  return Uint8Array.of(bytes.length, ...bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytes32Hex(hex: string, field: string): Uint8Array {
  const bytes = hexToBytes(hex.replace(/^0x/, ''));
  if (bytes.length !== 32) throw new Error(`${field} must be 32 bytes`);
  return bytes;
}

export function encodeActionIntent(i: ActionIntent): Uint8Array {
  return concat([
    u16le(i.schemaVersion),
    address32(i.treasury),
    address32(i.agentCap),
    u64le(i.nonce),
    u64le(i.expiresAtMs),
    u8(i.actionKind),
    u8(i.protocolId),
    vectorU8(i.coinTypeHash),
    u64le(i.amount),
    u64le(i.minHealthFactorBps),
    u64le(i.maxProtocolExposure),
    vectorU8(i.policyHash),
    vectorU8(i.inputHash),
    vectorU8(i.reportHash),
    vectorU8(i.intentHash)
  ]);
}

/** The exact bytes the enclave signs and Move re-derives. */
export function encodeEnvelope(signed: SignedActionIntent): Uint8Array {
  return concat([u8(DECISION_INTENT), u64le(signed.timestampMs), encodeActionIntent(signed.intent)]);
}

/** Sign an action intent. `secp256k1.sign` prehashes with sha256 by default. */
export function signActionIntent(
  signed: SignedActionIntent,
  privKey: Uint8Array
): { payload: ActionIntent; signature: string } {
  const msg = encodeEnvelope(signed);
  const sig = secp256k1.sign(msg, privKey);
  const signature = sig instanceof Uint8Array ? sig : (sig as { toBytes(): Uint8Array }).toBytes();
  return { payload: signed.intent, signature: bytesToHex(signature) };
}

export function publicKeyHex(privKey: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(privKey, true)); // 33-byte compressed
}

function digest(byte: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => byte);
}

// Parity self-test: this fixed vector is accepted by
// move/sources/decision.move's `verify_real_enclave_signature` test.
const SELF_TEST = {
  priv: '11'.repeat(32),
  signed: {
    timestampMs: 1_700_000_000_000n,
    intent: {
      schemaVersion: 1,
      treasury: '0x1',
      agentCap: '0x2',
      nonce: 7n,
      expiresAtMs: 1_800_000_000_000n,
      actionKind: ACTION_SUPPLY,
      protocolId: PROTOCOL_NAVI,
      coinTypeHash: digest(0x11),
      amount: 1000n,
      minHealthFactorBps: 12_500n,
      maxProtocolExposure: 100_000n,
      policyHash: digest(0x22),
      inputHash: digest(0x33),
      reportHash: digest(0x44),
      intentHash: digest(0x55)
    }
  } satisfies SignedActionIntent,
  actionIntent:
    '010000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002070000000000000000505c18a30100000102201111111111111111111111111111111111111111111111111111111111111111e803000000000000d430000000000000a086010000000000202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333204444444444444444444444444444444444444444444444444444444444444444205555555555555555555555555555555555555555555555555555555555555555',
  envelope:
    '000068e5cf8b010000010000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002070000000000000000505c18a30100000102201111111111111111111111111111111111111111111111111111111111111111e803000000000000d430000000000000a086010000000000202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333204444444444444444444444444444444444444444444444444444444444444444205555555555555555555555555555555555555555555555555555555555555555',
  pk: '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
  signature: '34c0d244c8961abb99440aab9b006dc2010310a8b8f3736a5959331602280430570b2eaa49b01a51ded426426f00d8946bec7b569e3349dfdc8f470fce34423f'
};

export function runSelfTest(): void {
  const priv = hexToBytes(SELF_TEST.priv);
  const actionIntent = bytesToHex(encodeActionIntent(SELF_TEST.signed.intent));
  if (actionIntent !== SELF_TEST.actionIntent) {
    throw new Error(`ActionIntent BCS drift!\n  got ${actionIntent}\n  exp ${SELF_TEST.actionIntent}`);
  }
  const env = bytesToHex(encodeEnvelope(SELF_TEST.signed));
  if (env !== SELF_TEST.envelope) {
    throw new Error(`BCS envelope drift!\n  got ${env}\n  exp ${SELF_TEST.envelope}`);
  }
  if (publicKeyHex(priv) !== SELF_TEST.pk) throw new Error('public key drift');
  if (signActionIntent(SELF_TEST.signed, priv).signature !== SELF_TEST.signature) {
    throw new Error('signature drift from the on-chain-verified vector');
  }
}
