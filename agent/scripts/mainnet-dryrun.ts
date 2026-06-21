// "Mainnet fork" test, Sui-style. Sui has no EVM-style fork (no local clone of mainnet
// objects), so the equivalent is dryRunTransactionBlock: SIMULATE a tx against CURRENT
// live mainnet state — no signature, no gas spent, no funds moved — and read the real
// abort/effects. This catches the integration unknowns (wrong Version/Market ids, type
// args, version guards, unexpected requirements) before any deploy or real funds.
//
// This script validates the SCALLOP deposit (`mint`) against live mainnet by splitting a
// tiny coin from gas (SUI — so no real USDC is needed) and minting sCoin. If it reports
// SUCCESS, our understanding of Scallop's mint matches reality.
//
//   SCALLOP_PACKAGE=0x<current scallop pkg> SCALLOP_VERSION=0x<current Version> \
//   SCALLOP_MARKET=0x<Market> ADDR=0x<your mainnet addr with some SUI> \
//   bun agent/scripts/mainnet-dryrun.ts
//
// IMPORTANT — resolve ALL three ids from the LIVE Scallop SDK at run time, NOT hardcoded:
//   const sdk = new Scallop({ networkType: 'mainnet' });
//   const a = await sdk.getScallopAddress();   // a.get('core.{version,market,object}')
// Scallop's package + Version are UPGRADE-GATED: `mint` calls `version::assert_current_version`,
// so a stale package OR a stale Version object aborts (513 / TypeMismatch). This was observed
// live (2026-06-21): a hardcoded package/Version went stale and failed the dry-run. The whole
// point of this script is to catch exactly that — so feed it freshly-resolved ids.
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
// The CALL target (latest upgraded protocol package). Required — no stale default: a hardcoded
// package goes out of date on every Scallop upgrade. Our Move stub-LINKAGE uses the type-origin
// 0xefe8b36d…; the PTB call target is the current package from the live SDK.
const PKG = env('SCALLOP_PACKAGE');
const VERSION = env('SCALLOP_VERSION'); // shared Version object (current — upgrade-gated)
const MARKET = env('SCALLOP_MARKET'); // shared Market object
const ADDR = env('ADDR'); // sender — needs a little SUI for gas resolution (NOT spent in dry-run)
const COIN = process.env.COIN ?? '0x2::sui::SUI'; // test with SUI split from gas → no USDC needed
const AMOUNT = BigInt(process.env.AMOUNT ?? '1000000'); // 0.001 SUI, tiny

const client = new SuiClient({ url: RPC });

async function main() {
  console.log(
    `Dry-running Scallop mint<${COIN.split('::').pop()}> against live mainnet (no funds, no signature)…`
  );

  const tx = new Transaction();
  tx.setSender(ADDR);
  tx.setGasBudget(50_000_000);

  // Split the deposit coin from the gas coin (SUI) — avoids needing a real USDC object.
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(AMOUNT)]);
  // protocol::mint::mint<T>(version, market, coin, clock) -> Coin<MarketCoin<T>>
  const sCoin = tx.moveCall({
    target: `${PKG}::mint::mint`,
    typeArguments: [COIN],
    arguments: [tx.object(VERSION), tx.object(MARKET), coin, tx.object('0x6')]
  });
  tx.transferObjects([sCoin], tx.pure.address(ADDR));

  const built = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: built });

  console.log('\nstatus:', res.effects.status.status);
  if (res.effects.status.status !== 'success') {
    console.log('abort/error:', res.effects.status.error);
    console.log('\n✗ Scallop mint would FAIL — fix the ids/type-args/requirements above before going live.');
    return;
  }
  console.log('✓ Scallop mint would SUCCEED against live mainnet.');
  console.log('  created objects (sCoin):', res.effects.created?.length ?? 0);
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
