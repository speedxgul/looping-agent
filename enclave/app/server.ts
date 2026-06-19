// Enclave signing service. Holds a secp256k1 key and signs treasury decisions
// the Sui `decision.move` verifier accepts. Runs a BCS/signature parity self-test
// on boot (fails loud if it has drifted from the on-chain verifier).
//
// In a real Nitro enclave the key is generated INSIDE and bound by attestation;
// for local dev / Oyster, set ENCLAVE_PRIVATE_KEY (hex) or it uses a fixed dev key.
import { hexToBytes } from '@noble/hashes/utils.js';
import { type Decision, publicKeyHex, runSelfTest, signDecision } from './decision.ts';

const PORT = 8080;

function loadKey(): Uint8Array {
  const env = process.env.ENCLAVE_PRIVATE_KEY;
  if (env) return hexToBytes(env.replace(/^0x/, ''));
  console.warn('[dev] ENCLAVE_PRIVATE_KEY not set — using fixed dev key (NOT for production)');
  return hexToBytes('11'.repeat(32));
}

runSelfTest(); // aborts boot if BCS/signing drifted from move/sources/decision.move
const PRIV = loadKey();
const PUBKEY = publicKeyHex(PRIV);
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

    if (url.pathname === '/sign-decision' && req.method === 'POST') {
      const body = (await req.json()) as Record<string, unknown>;
      const decision: Decision = {
        treasury: String(body.treasury),
        amount: BigInt(body.amount as string | number),
        nonce: BigInt(body.nonce as string | number),
        timestampMs: BigInt((body.timestampMs as string | number | undefined) ?? Date.now())
      };
      const { signature } = signDecision(decision, PRIV);
      return Response.json({
        public_key: PUBKEY,
        intent: 0,
        timestamp_ms: decision.timestampMs.toString(),
        payload: {
          treasury: decision.treasury,
          amount: decision.amount.toString(),
          nonce: decision.nonce.toString()
        },
        signature
      });
    }

    return new Response('not found\n', { status: 404 });
  }
});
