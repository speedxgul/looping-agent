// Hand-rolled BCS encoder for ActionIntent — keeps the enclave dependency-minimal
// (@noble only) for a small, reproducible PCR. Byte-parity with Move + @mysten/sui
// is pinned by the self-test vector below (fails loud on any drift).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const DECISION_INTENT = 0;

export interface ActionIntent {
  schemaVersion: number;
  chainId: Uint8Array;
  treasuryId: string;
  agentCapId: string;
  nonce: bigint;
  expiresAtMs: bigint;
  actionKind: number;
  protocolId: number;
  assetType: Uint8Array;
  amount: bigint;
  minHealthFactorBps: bigint;
  maxProtocolExposure: bigint;
  policyHash: Uint8Array;
  inputHash: Uint8Array;
  rationaleHash: Uint8Array;
}

const u16le = (v: number) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff]);
function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function uleb128(n: number): Uint8Array {
  const out: number[] = [];
  let x = n;
  do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x);
  return Uint8Array.from(out);
}
const bytesVec = (b: Uint8Array) => Uint8Array.from([...uleb128(b.length), ...b]);
function address32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').padStart(64, '0');
  if (clean.length !== 64) throw new Error(`bad address: ${hex}`);
  return hexToBytes(clean);
}

export function encodePayload(a: ActionIntent): Uint8Array {
  return Uint8Array.from([
    ...u16le(a.schemaVersion),
    ...bytesVec(a.chainId),
    ...address32(a.treasuryId),
    ...address32(a.agentCapId),
    ...u64le(a.nonce),
    ...u64le(a.expiresAtMs),
    a.actionKind,
    a.protocolId,
    ...bytesVec(a.assetType),
    ...u64le(a.amount),
    ...u64le(a.minHealthFactorBps),
    ...u64le(a.maxProtocolExposure),
    ...bytesVec(a.policyHash),
    ...bytesVec(a.inputHash),
    ...bytesVec(a.rationaleHash)
  ]);
}

/** intent:u8 ++ timestamp_ms:u64 ++ payload — the exact bytes Move re-derives. */
export function encodeEnvelope(a: ActionIntent, timestampMs: bigint): Uint8Array {
  return Uint8Array.from([DECISION_INTENT, ...u64le(timestampMs), ...encodePayload(a)]);
}

export function signActionIntent(a: ActionIntent, timestampMs: bigint, priv: Uint8Array): { signature: string } {
  const sig = secp256k1.sign(encodeEnvelope(a, timestampMs), priv);
  const bytes = sig instanceof Uint8Array ? sig : (sig as { toBytes(): Uint8Array }).toBytes();
  return { signature: bytesToHex(bytes) };
}

// --- Parity self-test (fails loud at boot if BCS/signing drifted from Move) ---
const SELF_TEST = {
  priv: '11'.repeat(32),
  timestampMs: 1_700_000_000_000n,
  intent: {
    schemaVersion: 1, chainId: Uint8Array.from([0x04]),
    treasuryId: '0x1', agentCapId: '0x2', nonce: 7n, expiresAtMs: 1_700_000_100_000n,
    actionKind: 0, protocolId: 0, assetType: new TextEncoder().encode('USDC'), amount: 1000n,
    minHealthFactorBps: 0n, maxProtocolExposure: 0n,
    policyHash: new Uint8Array(32).fill(0x11),
    inputHash: new Uint8Array(32).fill(0x22),
    rationaleHash: new Uint8Array(32).fill(0x33)
  } as ActionIntent,
  envelope: '000068e5cf8b01000001000104000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020700000000000000a0eee6cf8b01000000000455534443e80300000000000000000000000000000000000000000000201111111111111111111111111111111111111111111111111111111111111111202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333',
  signature: '3eff101a6e656813555c38d1ba4a48ddc29bc356abfcc21b2548eb5a4a7b702d2cc6d9f86bdc40d417872662f6c19ba9b5fa52e0148984026278d8d74383fe89'
};

export function runActionIntentSelfTest(): void {
  const env = bytesToHex(encodeEnvelope(SELF_TEST.intent, SELF_TEST.timestampMs));
  if (env !== SELF_TEST.envelope) throw new Error(`ActionIntent BCS drift!\n got ${env}\n exp ${SELF_TEST.envelope}`);
  const sig = signActionIntent(SELF_TEST.intent, SELF_TEST.timestampMs, hexToBytes(SELF_TEST.priv)).signature;
  if (sig !== SELF_TEST.signature) throw new Error('ActionIntent signature drift from the on-chain vector');
}
