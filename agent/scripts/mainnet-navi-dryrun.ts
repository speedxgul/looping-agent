// "Mainnet fork" test for the NAVI deposit, Sui-style. Sui has no EVM-style fork, so the
// equivalent is dryRunTransactionBlock: SIMULATE a deposit against CURRENT live mainnet state
// — no signature, no gas spent, no funds moved — and read the real abort/effects. This is the
// cheapest way to surface NAVI's integration unknowns (pool/storage/incentive object versions,
// asset id, type args) before any deploy or real funds.
//
// It mirrors what our NAVI adapter's deposit ultimately drives, but via the NAVI SDK's
// `depositCoinPTB` (which resolves the Storage/Pool/Incentive object ids for us from the live
// registry — far less brittle than hand-pinning them). NAVI deposit needs NO oracle refresh
// (only its withdraw does), so this is a clean, self-contained check: split a tiny SUI coin
// from gas (so no USDC/funded position is needed) and deposit it into the SUI pool.
//
// NOTE ON PARITY: the SDK's `depositCoinPTB` uses NAVI's address-based deposit; our on-chain
// adapter uses the AccountCap path (`incentive_v3::deposit_with_account_cap`) for non-custody.
// Both hit the same Storage/Pool/Incentive shared objects, so a SUCCESS here confirms those
// objects + the SUI asset are live and our understanding of the deposit is correct; the
// account-cap arg is the only delta (validated separately at the signature level).
//
//   ADDR=0x<your mainnet addr with a little SUI> bun agent/scripts/mainnet-navi-dryrun.ts
//
// (The sender just needs to OWN some SUI so the dry-run can resolve gas — nothing is spent,
//  no signature is produced.)

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { depositCoinPTB } from '@naviprotocol/lending';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
const ADDR = env('ADDR'); // sender — needs a little SUI for gas resolution (NOT spent in dry-run)
const COIN = process.env.COIN ?? '0x2::sui::SUI'; // SUI split from gas → no USDC needed
const AMOUNT = BigInt(process.env.AMOUNT ?? '100000000'); // 0.1 SUI, tiny

const client = new SuiClient({ url: RPC, network: 'mainnet' });

async function main() {
  console.log(
    `Dry-running NAVI deposit<${COIN.split('::').pop()}> against live mainnet (no funds, no signature)…`
  );

  const tx = new Transaction();
  tx.setSender(ADDR);
  tx.setGasBudget(50_000_000);

  // Split the deposit coin from the gas coin (SUI) — avoids needing a real USDC object.
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(AMOUNT)]);
  // The SDK resolves Storage / Pool<SUI> / Incentive ids from the live NAVI registry.
  await depositCoinPTB(tx, COIN, coin, { env: 'prod' });

  const built = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: built });

  console.log('\nstatus:', res.effects.status.status);
  if (res.effects.status.status !== 'success') {
    console.log('abort/error:', res.effects.status.error);
    console.log('\n✗ NAVI deposit would FAIL — fix the ids/type-args/requirements above before going live.');
    return;
  }
  console.log('✓ NAVI deposit would SUCCEED against live mainnet.');
  console.log('  created objects:', res.effects.created?.length ?? 0);
  console.log(
    '  balance changes:',
    (res.balanceChanges ?? []).map((b) => `${b.coinType.split('::').pop()} ${b.amount}`).join(', ')
  );
  console.log('  simulated gas:', res.effects.gasUsed.computationCost, '(computation)');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
