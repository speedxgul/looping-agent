// TESTNET, REAL ATTESTATION + IN-ENCLAVE DECISION: the strongest form of the demo.
// The agent sends only MARKET DATA (reserve curves) to the live Nitro enclave. The
// enclave runs the water-filling optimizer INSIDE the TEE, picks the venue + amount
// (clamped to the per-tx cap), and signs that ActionIntent with its attested key.
// The agent never chooses the amount or protocol — it just relays the signed decision
// to chain, which verifies the signature against the registered Enclave.
//
// Config from env (see deployments/testnet.env.example):
//   source ../deployments/testnet.env && cd agent && bun scripts/live-attested-decide.ts
// Required: PKG, ENCLAVE_IP, ENCLAVE, AGENTCAP, ADDR. Optional: RPC, COIN, BUDGET.
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
const BUDGET = process.env.BUDGET ?? '20000000'; // 0.02 SUI to optimize across venues
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

async function discover(): Promise<{ registry: string; treasury: string; perTxCap: string }> {
  const cap = await client.getObject({ id: AGENTCAP, options: { showContent: true } });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
  const treasury = (cap.data?.content as any)?.fields?.treasury as string;
  if (!treasury) throw new Error('could not read AgentCap.treasury');

  const t = await client.getObject({ id: treasury, options: { showContent: true } });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
  const perTxCap = (t.data?.content as any)?.fields?.per_tx_cap as string;

  const pkg = await client.getObject({ id: PKG, options: { showPreviousTransaction: true } });
  const publishTx = pkg.data?.previousTransaction;
  if (!publishTx) throw new Error('could not find package publish tx');
  const tx = await client.getTransactionBlock({ digest: publishTx, options: { showObjectChanges: true } });
  const reg = (tx.objectChanges ?? []).find(
    (c) => c.type === 'created' && 'objectType' in c && c.objectType.includes('::decision::DecisionRegistry')
  );
  if (!reg || !('objectId' in reg)) throw new Error('could not find DecisionRegistry in publish tx');
  return { registry: reg.objectId, treasury, perTxCap };
}

// Two candidate SUI lending venues. `mock` (our on-chain adapter, id 255) carries the
// higher reward APR, so the water-filling optimizer should fund it as the top leg —
// demonstrating a genuine choice that also lands on the only executable adapter.
function marketCurves() {
  return [
    {
      protocol: 'mock', // -> protocol_id 255 (the deployed adapter)
      asset: 'SUI',
      coinType: COIN,
      borrowAprPoints: [
        { util: 0, apr: 0 },
        { util: 0.8, apr: 12 },
        { util: 1, apr: 60 }
      ],
      reserveFactorPct: 15,
      borrowedRaw: '800000000000',
      availableLiquidityRaw: '200000000000',
      decimals: 9,
      price: 1.0,
      rewardSupplyApr: 9 // richer incentives -> should win
    },
    {
      protocol: 'navi',
      asset: 'SUI',
      coinType: COIN,
      borrowAprPoints: [
        { util: 0, apr: 0 },
        { util: 0.8, apr: 10 },
        { util: 1, apr: 45 }
      ],
      reserveFactorPct: 20,
      borrowedRaw: '600000000000',
      availableLiquidityRaw: '400000000000',
      decimals: 9,
      price: 1.0,
      rewardSupplyApr: 2
    }
  ];
}

// Ask the LIVE ENCLAVE to DECIDE (run the optimizer) and sign its choice.
async function enclaveDecide(treasury: string, perTxCap: string) {
  const body = {
    curves: marketCurves(),
    depositRaw: BUDGET,
    treasuryId: treasury,
    agentCapId: AGENTCAP,
    perTxCapRaw: perTxCap,
    nonce: Date.now().toString(),
    expiresAtMs: '9999999999999',
    assetType: Array.from(new TextEncoder().encode('SUI')),
    chainId: [0x04],
    timestampMs: TS.toString()
  };
  const res = await fetch(`http://${ENCLAVE_IP}:3000/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`enclave /decide failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as { public_key: string; signature: string; intent: Record<string, unknown> };
}

// Rebuild the agent-side ActionIntent from the enclave's returned (serialized) intent,
// verbatim — the signature is over exactly these fields.
function toIntent(i: Record<string, unknown>): ActionIntent {
  return {
    schemaVersion: Number(i.schemaVersion),
    chainId: i.chainId as number[],
    treasuryId: String(i.treasuryId),
    agentCapId: String(i.agentCapId),
    nonce: BigInt(i.nonce as string),
    expiresAtMs: BigInt(i.expiresAtMs as string),
    actionKind: Number(i.actionKind),
    protocolId: Number(i.protocolId),
    assetType: i.assetType as number[],
    amount: BigInt(i.amount as string),
    minHealthFactorBps: BigInt(i.minHealthFactorBps as string),
    maxProtocolExposure: BigInt(i.maxProtocolExposure as string),
    policyHash: i.policyHash as number[],
    inputHash: i.inputHash as number[],
    rationaleHash: i.rationaleHash as number[]
  };
}

async function main() {
  const { registry, treasury, perTxCap } = await discover();
  console.log('REGISTRY:', registry);
  console.log('TREASURY:', treasury, '| per_tx_cap:', perTxCap);

  const decided = await enclaveDecide(treasury, perTxCap);
  const intent = toIntent(decided.intent);
  console.log('\nenclave key:', decided.public_key);
  console.log('ENCLAVE DECISION (made in the TEE):');
  console.log(
    '  protocol_id:',
    intent.protocolId,
    intent.protocolId === 255 ? '(mock adapter)' : '(NOT executable on this package)'
  );
  console.log(
    '  amount     :',
    intent.amount.toString(),
    `(budget ${BUDGET}, clamped to per_tx_cap ${perTxCap})`
  );

  if (intent.protocolId !== 255) {
    console.log('\nThe optimizer picked a venue with no on-chain adapter here; skipping submit.');
    return;
  }

  const refs = {
    packageId: PKG,
    coinType: COIN,
    registryId: registry,
    treasuryId: treasury,
    enclaveId: ENCLAVE,
    agentCapId: AGENTCAP
  };
  const signer = loadSigner(ADDR);
  const tx = buildVerifiedSupplyTx(refs, intent, TS, decided.signature);
  const r = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true }
  });
  console.log('\nverified_supply_entry ->', r.effects?.status, '| tx:', r.digest);
  for (const e of r.events ?? []) console.log('  event:', e.type.split('::').pop(), e.parsedJson);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
