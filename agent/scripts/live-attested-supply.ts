// TESTNET, REAL ATTESTATION: drive verified_supply end-to-end where the signature
// comes from the live Nitro enclave on Oyster (signed with its attested /app/ecdsa.sec
// key, bound on-chain via register_enclave). Unlike live-verified-supply.ts (dev key,
// local signing), here the agent asks the enclave to sign and the chain verifies
// against the attested Enclave object.
//
// Config comes from the environment (see deployments/testnet.env.example):
//   source ../deployments/testnet.env && cd agent && bun scripts/live-attested-supply.ts
// Required: PKG, ENCLAVE_IP, ENCLAVE, AGENTCAP, ADDR. Optional: RPC, COIN, AMOUNT.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { fromBase64 } from '@mysten/sui/utils';
import type { ActionIntent } from '../src/core/actionIntent.ts';
import { buildVerifiedSupplyTx } from '../src/core/verifiedSupplyTx.ts';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const RPC = process.env.RPC ?? 'https://fullnode.testnet.sui.io:443';
const PKG = env('PKG');
const ENCLAVE_IP = env('ENCLAVE_IP');
const ENCLAVE = env('ENCLAVE');
const AGENTCAP = env('AGENTCAP');
const ADDR = env('ADDR');
const COIN = process.env.COIN ?? '0x2::sui::SUI';
const AMOUNT = BigInt(process.env.AMOUNT ?? '1000000000'); // default 1 SUI
const TS = 1_700_000_000_000n;

const client = new SuiClient({ url: RPC });

function loadSigner(activeAddress: string) {
  const ks: string[] = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, 'utf8'));
  for (const entry of ks) {
    const raw = fromBase64(entry);
    const kp =
      raw[0] === 0
        ? Ed25519Keypair.fromSecretKey(raw.slice(1))
        : Secp256k1Keypair.fromSecretKey(raw.slice(1));
    if (kp.getPublicKey().toSuiAddress() === activeAddress) return kp;
  }
  throw new Error('no keystore key matches ADDR');
}

// Discover the shared DecisionRegistry (created in the publish tx) and the
// Treasury (recorded inside the AgentCap).
async function discover(): Promise<{ registry: string; treasury: string }> {
  const cap = await client.getObject({ id: AGENTCAP, options: { showContent: true } });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
  const treasury = (cap.data?.content as any)?.fields?.treasury as string;
  if (!treasury) throw new Error('could not read AgentCap.treasury');

  const pkg = await client.getObject({ id: PKG, options: { showPreviousTransaction: true } });
  const publishTx = pkg.data?.previousTransaction;
  if (!publishTx) throw new Error('could not find package publish tx');
  const tx = await client.getTransactionBlock({ digest: publishTx, options: { showObjectChanges: true } });
  const reg = (tx.objectChanges ?? []).find(
    (c) => c.type === 'created' && 'objectType' in c && c.objectType.includes('::decision::DecisionRegistry')
  );
  if (!reg || !('objectId' in reg)) throw new Error('could not find DecisionRegistry in publish tx');
  return { registry: reg.objectId, treasury };
}

function makeIntent(treasury: string, amount: bigint, nonce: bigint): ActionIntent {
  return {
    schemaVersion: 1,
    chainId: [0x04],
    treasuryId: treasury,
    agentCapId: AGENTCAP,
    nonce,
    expiresAtMs: 9_999_999_999_999n,
    actionKind: 0,
    protocolId: 255,
    assetType: Array.from(new TextEncoder().encode('USDC')),
    amount,
    minHealthFactorBps: 0n,
    maxProtocolExposure: 0n,
    policyHash: Array(32).fill(0),
    inputHash: Array(32).fill(0),
    rationaleHash: Array(32).fill(0)
  };
}

// Ask the LIVE ENCLAVE to sign the intent with its attested key.
async function enclaveSign(intent: ActionIntent): Promise<{ signature: string; publicKey: string }> {
  const body = {
    schemaVersion: intent.schemaVersion,
    chainId: intent.chainId,
    treasuryId: intent.treasuryId,
    agentCapId: intent.agentCapId,
    nonce: intent.nonce.toString(),
    expiresAtMs: intent.expiresAtMs.toString(),
    actionKind: intent.actionKind,
    protocolId: intent.protocolId,
    assetType: intent.assetType,
    amount: intent.amount.toString(),
    minHealthFactorBps: intent.minHealthFactorBps.toString(),
    maxProtocolExposure: intent.maxProtocolExposure.toString(),
    policyHash: intent.policyHash,
    inputHash: intent.inputHash,
    rationaleHash: intent.rationaleHash,
    timestampMs: TS.toString()
  };
  const res = await fetch(`http://${ENCLAVE_IP}:3000/sign-action-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`enclave sign failed: HTTP ${res.status}`);
  const j = (await res.json()) as { signature: string; public_key: string };
  return { signature: j.signature, publicKey: j.public_key };
}

async function treasuryFunds(treasury: string): Promise<string> {
  const o = await client.getObject({ id: treasury, options: { showContent: true } });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
  return (o.data?.content as any)?.fields?.funds ?? '?';
}

async function main() {
  const { registry, treasury } = await discover();
  console.log('discovered REGISTRY:', registry);
  console.log('discovered TREASURY:', treasury);

  const refs = {
    packageId: PKG,
    coinType: COIN,
    registryId: registry,
    treasuryId: treasury,
    enclaveId: ENCLAVE,
    agentCapId: AGENTCAP
  };
  const signer = loadSigner(ADDR);
  console.log('submitter (gas):', ADDR);
  console.log('treasury funds before:', await treasuryFunds(treasury));

  // Use an always-increasing nonce so re-runs don't collide with consumed nonces.
  const nonce = BigInt(Date.now());

  // 1) VALID — the LIVE ENCLAVE signs; chain verifies against the attested Enclave.
  const good = makeIntent(treasury, AMOUNT, nonce);
  const { signature, publicKey } = await enclaveSign(good);
  console.log('\nenclave signed. enclave pubkey:', publicKey);
  const txGood = buildVerifiedSupplyTx(refs, good, TS, signature);
  const rGood = await client.signAndExecuteTransaction({
    signer,
    transaction: txGood,
    options: { showEffects: true, showEvents: true }
  });
  console.log('[1] VALID verified_supply_entry ->', rGood.effects?.status);
  console.log('    tx:', rGood.digest);
  for (const e of rGood.events ?? []) console.log('    event:', e.type.split('::').pop(), e.parsedJson);
  console.log('    treasury funds after:', await treasuryFunds(treasury), `(supplied ${AMOUNT})`);

  // 2) TAMPERED — reuse the valid signature but change the amount; signature must fail.
  const tampered = makeIntent(treasury, AMOUNT + 1n, nonce + 1n);
  const txBad = buildVerifiedSupplyTx(refs, tampered, TS, signature);
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
