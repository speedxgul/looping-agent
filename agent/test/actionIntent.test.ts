import { describe, expect, it } from 'bun:test';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type ActionIntent, encodePayload, signActionIntent } from '../src/core/actionIntent.js';

const ascii = (s: string) => Array.from(new TextEncoder().encode(s));
const VECTOR: ActionIntent = {
  schemaVersion: 1,
  chainId: [0x04],
  treasuryId: `0x${'00'.repeat(31)}01`,
  agentCapId: `0x${'00'.repeat(31)}02`,
  nonce: 7n,
  expiresAtMs: 1_700_000_100_000n,
  actionKind: 0,
  protocolId: 0,
  assetType: ascii('USDC'),
  amount: 1000n,
  minHealthFactorBps: 0n,
  maxProtocolExposure: 0n,
  policyHash: Array(32).fill(0x11),
  inputHash: Array(32).fill(0x22),
  rationaleHash: Array(32).fill(0x33)
};
const PRIV = hexToBytes('11'.repeat(32));
const PAYLOAD =
  '01000104000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020700000000000000a0eee6cf8b01000000000455534443e80300000000000000000000000000000000000000000000201111111111111111111111111111111111111111111111111111111111111111202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333';
const SIG =
  '3eff101a6e656813555c38d1ba4a48ddc29bc356abfcc21b2548eb5a4a7b702d2cc6d9f86bdc40d417872662f6c19ba9b5fa52e0148984026278d8d74383fe89';

describe('ActionIntent codec parity', () => {
  it('payload BCS matches the canonical vector', () => {
    expect(bytesToHex(encodePayload(VECTOR))).toBe(PAYLOAD);
  });
  it('signature matches the canonical vector', () => {
    expect(signActionIntent(VECTOR, 1_700_000_000_000n, PRIV)).toBe(SIG);
  });
});
