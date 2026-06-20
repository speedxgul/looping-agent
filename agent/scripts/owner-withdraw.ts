// OWNER-side withdrawal (the other half of the round-trip). The OwnerCap holder recovers
// the funds custodied in the Treasury via `<protocol>_adapter::owner_redeem` — this does
// NOT go through the enclave (the owner has direct authority; the agent never can).
//
// This demo recovers the MOCK position (the only adapter deployed on testnet). For real
// Suilend/NAVI withdraws, use buildOwnerRedeem{Suilend,Navi}Tx + an oracle-refresh command.
//
//   source ../deployments/testnet.env && cd agent && \
//   OWNERCAP=0x… bun scripts/owner-withdraw.ts
// Required: PKG, TREASURY, OWNERCAP, ADDR. Optional: RPC, COIN.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { fromBase64 } from '@mysten/sui/utils';
import { buildOwnerRedeemMockTx } from '../src/core/ownerRedeemTx.ts';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const RPC = process.env.RPC ?? 'https://fullnode.testnet.sui.io:443';
const PKG = env('PKG');
const TREASURY = env('TREASURY');
const OWNERCAP = env('OWNERCAP');
const ADDR = env('ADDR');
const COIN = process.env.COIN ?? '0x2::sui::SUI';

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
  throw new Error('no keystore key matches ADDR (must hold the OwnerCap)');
}

async function treasuryFunds(): Promise<string> {
  const o = await client.getObject({ id: TREASURY, options: { showContent: true } });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
  return (o.data?.content as any)?.fields?.funds ?? '?';
}

async function main() {
  const signer = loadSigner(ADDR);
  console.log('owner:', ADDR);
  console.log('treasury funds before:', await treasuryFunds());

  // OwnerCap-gated: redeem the custodied mock position back to the owner.
  const tx = buildOwnerRedeemMockTx({
    packageId: PKG,
    coinType: COIN,
    treasuryId: TREASURY,
    ownerCapId: OWNERCAP,
    ownerAddress: ADDR
  });
  const r = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showBalanceChanges: true }
  });
  console.log('\nowner_redeem ->', r.effects?.status, '| tx:', r.digest);
  for (const b of r.balanceChanges ?? []) {
    console.log('  balance change:', b.coinType.split('::').pop(), b.amount, '->', b.owner);
  }
  console.log('treasury funds after:', await treasuryFunds());
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
