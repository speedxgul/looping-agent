// LOCALNET demo: drive the attested verified_supply path end-to-end using the
// agent's own ActionIntent codec + PTB builder. Run: cd agent && bun scripts/live-verified-supply.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { fromBase64 } from '@mysten/sui/utils';
import { hexToBytes } from '@noble/hashes/utils.js';
import { type ActionIntent, signActionIntent } from '../src/core/actionIntent.ts';
import { buildVerifiedSupplyTx } from '../src/core/verifiedSupplyTx.ts';

// Object ids from the localnet demo steps (see README "Reproduce the live demo").
// Pass them as env vars: PKG, REGISTRY, ENCLAVE, TREASURY, AGENTCAP, ADDR.
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k} — see README "Reproduce the live demo"`);
  return v;
};
const RPC = process.env.RPC ?? 'http://127.0.0.1:9000';
const PKG = env('PKG');
const REGISTRY = env('REGISTRY');
const ENCLAVE = env('ENCLAVE');
const TREASURY = env('TREASURY');
const AGENTCAP = env('AGENTCAP');
const DEV_PRIV = hexToBytes('11'.repeat(32)); // canonical dev "enclave" key (registered on-chain)

const client = new SuiClient({ url: RPC });

// Load the active address's keypair from the Sui keystore (to pay gas + be the Submitter).
function loadSigner(activeAddress: string) {
  const ks: string[] = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, 'utf8'));
  for (const entry of ks) {
    const raw = fromBase64(entry); // [flag, 32-byte secret]
    const flag = raw[0];
    const secret = raw.slice(1);
    const kp = flag === 0 ? Ed25519Keypair.fromSecretKey(secret) : Secp256k1Keypair.fromSecretKey(secret);
    if (kp.getPublicKey().toSuiAddress() === activeAddress) return kp;
  }
  throw new Error('no keystore key matches the active address');
}

function makeIntent(amount: bigint, nonce: bigint): ActionIntent {
  return {
    schemaVersion: 1,
    chainId: [0x04],
    treasuryId: TREASURY,
    agentCapId: AGENTCAP,
    nonce,
    expiresAtMs: 9_999_999_999_999n,
    actionKind: 0,
    protocolId: 255, // mock adapter
    assetType: Array.from(new TextEncoder().encode('USDC')),
    amount,
    minHealthFactorBps: 0n,
    maxProtocolExposure: 0n,
    policyHash: Array(32).fill(0),
    inputHash: Array(32).fill(0),
    rationaleHash: Array(32).fill(0)
  };
}

const TS = 1_700_000_000_000n;
const refs = {
  packageId: PKG,
  coinType: '0x2::sui::SUI',
  registryId: REGISTRY,
  treasuryId: TREASURY,
  enclaveId: ENCLAVE,
  agentCapId: AGENTCAP
};

async function treasuryFunds(): Promise<string> {
  const o = await client.getObject({ id: TREASURY, options: { showContent: true } });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
  return (o.data?.content as any)?.fields?.funds ?? '?';
}

async function main() {
  const active = env('ADDR');
  const signer = loadSigner(active);
  console.log('submitter (gas payer):', active);
  console.log('treasury funds before:', await treasuryFunds());

  // 1) VALID: enclave-signed ActionIntent (amount from AMOUNT env, default 50 SUI)
  const AMOUNT = BigInt(process.env.AMOUNT ?? '50000000000');
  const good = makeIntent(AMOUNT, 1n);
  const goodSig = signActionIntent(good, TS, DEV_PRIV);
  const txGood = buildVerifiedSupplyTx(refs, good, TS, goodSig);
  const rGood = await client.signAndExecuteTransaction({
    signer,
    transaction: txGood,
    options: { showEffects: true, showEvents: true }
  });
  console.log('\n[1] VALID verified_supply_entry ->', rGood.effects?.status);
  for (const e of rGood.events ?? []) console.log('    event:', e.type.split('::').pop(), e.parsedJson);
  console.log('    treasury funds after:', await treasuryFunds(), `(supplied ${AMOUNT})`);

  // 2) TAMPERED: same signature, but amount changed to 60 SUI -> signature must fail
  const tampered = makeIntent(AMOUNT + 10_000_000n, 2n);
  const txBad = buildVerifiedSupplyTx(refs, tampered, TS, goodSig); // reuse the VALID sig
  try {
    const rBad = await client.signAndExecuteTransaction({
      signer,
      transaction: txBad,
      options: { showEffects: true }
    });
    console.log('\n[2] TAMPERED ->', rBad.effects?.status, '(SHOULD be failure)');
  } catch (err) {
    console.log('\n[2] TAMPERED rejected as expected:', String(err).split('\n')[0].slice(0, 160));
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
