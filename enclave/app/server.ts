// Enclave signing service — signs canonical ActionIntents that the on-chain
// `decision.move` verifier accepts. Runs a BCS/signature parity self-test on
// boot (fails loud if BCS or signing has drifted from the on-chain verifier).
//
// Key provisioning, in priority order:
//   1. /app/ecdsa.sec  — the REAL path. The Marlin Oyster blue base image (v3.0.0)
//      generates a secp256k1 keypair INSIDE the enclave at this path and runs a
//      second attestation-server on :1301 that binds the public key into a Nitro
//      attestation document's `public_key` field — exactly what on-chain
//      `register_enclave` reads. (Verified live: :1301 carried our 64-byte secp256k1
//      key; :1300 carries only the base's ed25519 identity key.) We just read the
//      file; the base handles generation + attestation.
//   2. ENCLAVE_PRIVATE_KEY (hex) — manual override for non-Oyster hosting.
//   3. DEV=1 — the fixed, PUBLIC test key. Never use in production.
// Port/attestation convention (matches the Marlin sui-oyster-demo): the app serves
// on :3000; the base serves attestations on :1301 (app key) and :1300 (base key).
import { existsSync, readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type ActionIntent, runActionIntentSelfTest, signActionIntent } from './action_intent.ts';
import { type DecideInput, decide } from './decide.ts';

const PORT = 3000;
const KEY_FILE = process.env.ENCLAVE_KEY_FILE ?? '/app/ecdsa.sec';

function loadKey(): Uint8Array {
  // 1. Attested key file provisioned by Oyster (`--deployment sui`).
  if (existsSync(KEY_FILE)) {
    const key = Uint8Array.from(readFileSync(KEY_FILE));
    if (key.length !== 32) {
      throw new Error(`${KEY_FILE}: expected a 32-byte secp256k1 key, got ${key.length} bytes`);
    }
    secp256k1.getPublicKey(key, true); // validate (throws on a bad scalar)
    console.log(`loaded attested signing key from ${KEY_FILE}`);
    return key;
  }
  // 2. Manual hex override.
  const env = process.env.ENCLAVE_PRIVATE_KEY;
  if (env) return hexToBytes(env.replace(/^0x/, ''));
  // 3. The fixed dev key is PUBLIC (committed in the repo) — refuse it unless DEV=1
  // is set explicitly, so a real deploy can never accidentally run a forgeable key.
  if (process.env.DEV === '1') {
    console.warn('[DEV] using the fixed, PUBLIC dev key — never use this in production');
    return hexToBytes('11'.repeat(32));
  }
  throw new Error(
    `No signing key. On Oyster, deploy with \`--deployment sui\` so the CVM provisions ${KEY_FILE} ` +
      'and binds its pubkey into the attestation. For local dev, set DEV=1 to use the fixed test key.'
  );
}

// --- JSON ↔ ActionIntent/DecideInput helpers ---
// HTTP carries bigints as strings and byte vectors as number[].

const u8arr = (v: unknown): Uint8Array =>
  Uint8Array.from(Array.isArray(v) ? (v as unknown[]).map(Number) : []);

const u8num = (v: unknown): number[] =>
  Array.isArray(v) ? (v as unknown[]).map(Number) : [];

const big = (v: unknown): bigint => BigInt(v as string | number);

function parseActionIntent(body: Record<string, unknown>): ActionIntent {
  return {
    schemaVersion: Number(body.schemaVersion),
    chainId: u8arr(body.chainId),
    treasuryId: String(body.treasuryId),
    agentCapId: String(body.agentCapId),
    nonce: big(body.nonce),
    expiresAtMs: big(body.expiresAtMs),
    actionKind: Number(body.actionKind),
    protocolId: Number(body.protocolId),
    assetType: u8arr(body.assetType),
    amount: big(body.amount),
    minHealthFactorBps: big(body.minHealthFactorBps),
    maxProtocolExposure: big(body.maxProtocolExposure),
    policyHash: u8arr(body.policyHash),
    inputHash: u8arr(body.inputHash),
    rationaleHash: u8arr(body.rationaleHash)
  };
}

function parseDecideInput(body: Record<string, unknown>): DecideInput {
  return {
    curves: body.curves as DecideInput['curves'],
    depositRaw: big(body.depositRaw),
    treasuryId: String(body.treasuryId),
    agentCapId: String(body.agentCapId),
    perTxCapRaw: big(body.perTxCapRaw),
    nonce: big(body.nonce),
    expiresAtMs: big(body.expiresAtMs),
    assetType: u8num(body.assetType),
    chainId: u8num(body.chainId),
    timestampMs: big(body.timestampMs)
  };
}

function serializeIntent(i: ActionIntent): Record<string, unknown> {
  return {
    schemaVersion: i.schemaVersion,
    chainId: Array.from(i.chainId),
    treasuryId: i.treasuryId,
    agentCapId: i.agentCapId,
    nonce: i.nonce.toString(),
    expiresAtMs: i.expiresAtMs.toString(),
    actionKind: i.actionKind,
    protocolId: i.protocolId,
    assetType: Array.from(i.assetType),
    amount: i.amount.toString(),
    minHealthFactorBps: i.minHealthFactorBps.toString(),
    maxProtocolExposure: i.maxProtocolExposure.toString(),
    policyHash: Array.from(i.policyHash),
    inputHash: Array.from(i.inputHash),
    rationaleHash: Array.from(i.rationaleHash)
  };
}

// Boot checks — fail loud before accepting any requests.
runActionIntentSelfTest();
const PRIV = loadKey();
const PUBKEY = bytesToHex(secp256k1.getPublicKey(PRIV, true));
console.log(`enclave signer listening on :${PORT}; public key = ${PUBKEY}`);

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') return new Response('ok\n');

    if (url.pathname === '/public-key') {
      return Response.json({ public_key: PUBKEY, scheme: 'secp256k1' });
    }

    if (url.pathname === '/sign-action-intent' && req.method === 'POST') {
      const body = (await req.json()) as Record<string, unknown>;
      const intent = parseActionIntent(body);
      const timestampMs = big(body.timestampMs);
      const { signature } = signActionIntent(intent, timestampMs, PRIV);
      return Response.json({
        public_key: PUBKEY,
        signature,
        intent: serializeIntent(intent),
        timestamp_ms: timestampMs.toString()
      });
    }

    if (url.pathname === '/decide' && req.method === 'POST') {
      const body = (await req.json()) as Record<string, unknown>;
      const { intent, signature } = decide(parseDecideInput(body), PRIV);
      return Response.json({
        public_key: PUBKEY,
        signature,
        intent: serializeIntent(intent)
      });
    }

    return new Response('not found\n', { status: 404 });
  }
});
