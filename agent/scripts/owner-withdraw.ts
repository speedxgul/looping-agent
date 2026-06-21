// OWNER-side withdrawal (the other half of the round-trip). The OwnerCap holder recovers
// the funds custodied in the Treasury via `<protocol>_adapter::owner_redeem` — this does
// NOT go through the enclave (the owner has direct authority; the agent never can).
//
// PROTOCOL selects the adapter:
//   mock    — testnet demo (the only adapter deployed on testnet)
//   scallop — mainnet; redeems the whole sCoin position; NO oracle
//   navi    — mainnet; redeems `AMOUNT`; PREPENDS a NAVI oracle refresh (withdraw aborts stale)
// (Suilend withdraw also needs an oracle refresh — add it the same way as NAVI when wired.)
//
//   source deployments/mainnet.env && cd agent && PROTOCOL=scallop bun scripts/owner-withdraw.ts
//
// Required (all): PKG, TREASURY, OWNERCAP, ADDR. COIN defaults to SUI — set to your USDC type
//   for real positions. scallop: SCALLOP_VERSION, SCALLOP_MARKET. navi: NAVI_ORACLE, NAVI_STORAGE,
//   NAVI_POOL, NAVI_INCENTIVE_V2, NAVI_INCENTIVE_V3, NAVI_ASSET, AMOUNT.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getPool, updateOraclePriceBeforeUserOperationPTB } from '@naviprotocol/lending';
import {
  buildOwnerRedeemMockTx,
  buildOwnerRedeemNaviTx,
  buildOwnerRedeemScallopTx
} from '../src/core/ownerRedeemTx.ts';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const PROTOCOL = (process.env.PROTOCOL ?? 'mock').toLowerCase();
const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
const PKG = env('PKG');
const TREASURY = env('TREASURY');
const OWNERCAP = env('OWNERCAP');
const ADDR = env('ADDR');
const COIN = process.env.COIN ?? '0x2::sui::SUI';
const naviEnv = RPC.includes('testnet') || RPC.includes('devnet') ? 'dev' : 'prod';

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

/** Build the protocol-specific owner_redeem PTB (prepending an oracle refresh where needed). */
async function buildWithdrawTx(): Promise<Transaction> {
  const base = {
    packageId: PKG,
    coinType: COIN,
    treasuryId: TREASURY,
    ownerCapId: OWNERCAP,
    ownerAddress: ADDR
  };

  if (PROTOCOL === 'mock') return buildOwnerRedeemMockTx(base);

  if (PROTOCOL === 'scallop') {
    // Scallop redeem needs no oracle — redeems the whole custodied sCoin position.
    return buildOwnerRedeemScallopTx({
      ...base,
      versionId: env('SCALLOP_VERSION'),
      marketId: env('SCALLOP_MARKET')
    });
  }

  if (PROTOCOL === 'navi') {
    // NAVI's value-computing withdraw aborts on a stale oracle, so prepend the same Pyth
    // refresh the custodial path uses BEFORE owner_redeem (PTB commands run in order).
    const tx = new Transaction();
    const pool = await getPool(COIN, { env: naviEnv });
    await updateOraclePriceBeforeUserOperationPTB(tx, ADDR, [pool], { env: naviEnv });
    return buildOwnerRedeemNaviTx(
      {
        ...base,
        oracleId: env('NAVI_ORACLE'),
        storageId: env('NAVI_STORAGE'),
        poolId: env('NAVI_POOL'),
        incentiveV2Id: env('NAVI_INCENTIVE_V2'),
        incentiveV3Id: env('NAVI_INCENTIVE_V3'),
        assetId: Number(env('NAVI_ASSET')),
        amount: BigInt(env('AMOUNT'))
      },
      tx
    );
  }

  throw new Error(`unknown PROTOCOL '${PROTOCOL}' (use mock | scallop | navi)`);
}

async function main() {
  const signer = loadSigner(ADDR);
  console.log(`owner: ${ADDR} | protocol: ${PROTOCOL}`);
  console.log('treasury funds before:', await treasuryFunds());

  const tx = await buildWithdrawTx();
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
