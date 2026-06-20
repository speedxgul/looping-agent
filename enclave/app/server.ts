// Enclave signing service. Holds a secp256k1 key and signs treasury decisions
// the Sui `decision.move` verifier accepts. Runs a BCS/signature parity self-test
// on boot (fails loud if it has drifted from the on-chain verifier).
//
// In a real Nitro enclave the key is generated INSIDE and bound by attestation;
// for local dev / Oyster, set ENCLAVE_PRIVATE_KEY (hex) or it uses a fixed dev key.
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  ACTION_SUPPLY,
  PROTOCOL_NAVI,
  type ActionIntent,
  bytes32Hex,
  publicKeyHex,
  runSelfTest,
  signActionIntent
} from './decision.ts';

const PORT = Number(process.env.PORT ?? 8080);

function loadKey(): Uint8Array {
  const env = process.env.ENCLAVE_PRIVATE_KEY;
  if (env) return hexToBytes(env.replace(/^0x/, ''));
  // The fixed dev key is PUBLIC (committed in the repo) — refuse it unless DEV=1 is
  // set explicitly, so a real deploy can never accidentally run a forgeable key.
  if (process.env.DEV === '1') {
    console.warn('[DEV] using the fixed, PUBLIC dev key — never use this in production');
    return hexToBytes('11'.repeat(32));
  }
  throw new Error(
    'ENCLAVE_PRIVATE_KEY is not set. In a real enclave the key is provisioned inside the ' +
      'TEE (e.g. via Seal, gated by PCR). For local dev, set DEV=1 to use the fixed test key.'
  );
}

runSelfTest(); // aborts boot if BCS/signing drifted from move/sources/decision.move
const PRIV = loadKey();
const PUBKEY = publicKeyHex(PRIV);
console.log(`enclave signer listening on :${PORT}; public key = ${PUBKEY}`);

function bigintField(body: Record<string, unknown>, camel: string, snake: string): bigint {
  const value = body[camel] ?? body[snake];
  if (value === undefined) throw new Error(`missing ${camel}`);
  return BigInt(value as string | number);
}

function numberField(body: Record<string, unknown>, camel: string, snake: string, fallback: number): number {
  const value = body[camel] ?? body[snake] ?? fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`bad ${camel}`);
  return n;
}

function stringField(body: Record<string, unknown>, camel: string, snake: string): string {
  const value = body[camel] ?? body[snake];
  if (typeof value !== 'string') throw new Error(`missing ${camel}`);
  return value;
}

function parseActionIntent(body: Record<string, unknown>): ActionIntent {
  return {
    schemaVersion: numberField(body, 'schemaVersion', 'schema_version', 1),
    treasury: stringField(body, 'treasury', 'treasury'),
    agentCap: stringField(body, 'agentCap', 'agent_cap'),
    nonce: bigintField(body, 'nonce', 'nonce'),
    expiresAtMs: bigintField(body, 'expiresAtMs', 'expires_at_ms'),
    actionKind: numberField(body, 'actionKind', 'action_kind', ACTION_SUPPLY),
    protocolId: numberField(body, 'protocolId', 'protocol_id', PROTOCOL_NAVI),
    coinTypeHash: bytes32Hex(stringField(body, 'coinTypeHash', 'coin_type_hash'), 'coinTypeHash'),
    amount: bigintField(body, 'amount', 'amount'),
    minHealthFactorBps: bigintField(body, 'minHealthFactorBps', 'min_health_factor_bps'),
    maxProtocolExposure: bigintField(body, 'maxProtocolExposure', 'max_protocol_exposure'),
    policyHash: bytes32Hex(stringField(body, 'policyHash', 'policy_hash'), 'policyHash'),
    inputHash: bytes32Hex(stringField(body, 'inputHash', 'input_hash'), 'inputHash'),
    reportHash: bytes32Hex(stringField(body, 'reportHash', 'report_hash'), 'reportHash'),
    intentHash: bytes32Hex(stringField(body, 'intentHash', 'intent_hash'), 'intentHash')
  };
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function jsonIntent(i: ActionIntent): Record<string, string | number> {
  return {
    schema_version: i.schemaVersion,
    treasury: i.treasury,
    agent_cap: i.agentCap,
    nonce: i.nonce.toString(),
    expires_at_ms: i.expiresAtMs.toString(),
    action_kind: i.actionKind,
    protocol_id: i.protocolId,
    coin_type_hash: hex(i.coinTypeHash),
    amount: i.amount.toString(),
    min_health_factor_bps: i.minHealthFactorBps.toString(),
    max_protocol_exposure: i.maxProtocolExposure.toString(),
    policy_hash: hex(i.policyHash),
    input_hash: hex(i.inputHash),
    report_hash: hex(i.reportHash),
    intent_hash: hex(i.intentHash)
  };
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') return new Response('ok\n');

    if (url.pathname === '/public-key') {
      return Response.json({ public_key: PUBKEY, scheme: 'secp256k1' });
    }

    if (url.pathname === '/sign-decision' && req.method === 'POST') {
      const body = (await req.json()) as Record<string, unknown>;
      const timestampMs = BigInt((body.timestampMs as string | number | undefined) ?? Date.now());
      const actionIntent = parseActionIntent(body);
      const { signature } = signActionIntent({ intent: actionIntent, timestampMs }, PRIV);
      return Response.json({
        public_key: PUBKEY,
        intent: 0,
        timestamp_ms: timestampMs.toString(),
        payload: jsonIntent(actionIntent),
        signature
      });
    }

    return new Response('not found\n', { status: 404 });
  }
});
