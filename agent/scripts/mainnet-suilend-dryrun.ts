// "Mainnet fork" test for the SUILEND deposit, Sui-style. Sui has no EVM-style fork, so the
// equivalent is dryRunTransactionBlock: SIMULATE a deposit against CURRENT live mainnet state
// — no signature, no gas spent, no funds moved — and read the real abort/effects.
//
// This mirrors our `suilend_adapter::supply_and_custody` FIRST-deposit path with RAW moveCalls:
//   deposit_liquidity_and_mint_ctokens<P,T>  →  create_obligation<P>  →
//   deposit_ctokens_into_obligation<P,T>  →  (custody the ObligationOwnerCap)
// We use RAW moveCalls here rather than @suilend/sdk's `SuilendClient.initialize`. Note: the SDK
// 3.x needs a gRPC/core-API client (getObject({objectId, include})), NOT a legacy JSON-RPC
// `new SuiClient(...)` (getObject({id, options})) — handing it the latter throws "Invalid Sui
// Object id". (The agent itself is fine: `SuiExecutionClient.client` is already a `SuiGrpcClient`,
// so its live Suilend path works — verified. A standalone script using the SDK must construct a
// `new SuiGrpcClient({ network, baseUrl })`.) Raw calls sidestep the SDK entirely.
//
// ORACLE CHAIN: a "cold" mainnet read finds the SUI reserve price stale (deposit aborts code 1),
// and even refresh_reserve_price aborts (code 1) because Pyth's own PriceInfoObject is stale. So
// the full, deterministic path — which this script wires end-to-end — is:
//   pyth::update_price_feeds (Hermes signed data, via our pythClient + @pythnetwork/pyth-sui-js)
//     → lending_market::refresh_reserve_price  →  deposit_liquidity_and_mint_ctokens  → …
// (A real frontend deposit can skip the first two when another actor refreshed the reserve in a
// nearby block; this script never relies on that.)
//
// STATUS (2026-06-21): all ids resolve, the chain builds + executes through the Pyth update, and
// reaches `refresh_reserve_price`, which still aborts code 1 — a Suilend-internal price check
// (likely a freshness/confidence window). Verified NON-issues: reserve 0 IS the SUI feed
// (0x23d731…) and that feed maps to PriceInfoObject 0x801dbc2f… (so no feed/object mismatch).
// Resolving the last abort needs Suilend Move-source analysis + a real chain clock (the sandbox
// clock here is fictional). Run this at deploy time with your funded addr to iterate — the
// structure (adapter call order + full oracle chain) is correct; this is the last live detail.
// Contrast: NAVI's dry-run (mainnet-navi-dryrun.ts) SUCCEEDS — Suilend is the fiddliest.
//
//   ADDR=0x<your mainnet addr w/ a little SUI> bun agent/scripts/mainnet-suilend-dryrun.ts
//
// The sender just needs to OWN some SUI (gas resolution + the tiny deposit). Nothing is signed.
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { SuiPythClient } from '@pythnetwork/pyth-sui-js';
import { fetchPythUpdate, PYTH_FEED_IDS } from '../src/clients/http/pythClient.js';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
const ADDR = env('ADDR'); // sender — needs a little SUI (gas resolution + the tiny deposit)
// Suilend mainnet ids (resolved live 2026-06-21; deposits call the type-origin package directly,
// so unlike Scallop these don't version-drift). Override via env if Suilend republishes.
const PKG =
  process.env.SUILEND_PACKAGE ?? '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf';
const LENDING_MARKET =
  process.env.SUILEND_LENDING_MARKET ?? '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1';
const MARKET_TYPE = process.env.SUILEND_MARKET_TYPE ?? `${PKG}::suilend::MAIN_POOL`; // P
const COIN = process.env.COIN ?? '0x2::sui::SUI'; // T — deposit SUI into the SUI reserve, no USDC needed
const RESERVE_INDEX = BigInt(process.env.SUILEND_RESERVE_INDEX ?? '0'); // SUI = reserve 0 in MAIN_POOL
const FEED_ID = process.env.PYTH_FEED_ID ?? PYTH_FEED_IDS.SUI; // Pyth price-feed id for the asset (SUI)
const AMOUNT = BigInt(process.env.AMOUNT ?? '10000000'); // 0.01 SUI, tiny
// Verified mainnet state objects for the on-chain Pyth update.
const PYTH_STATE =
  process.env.PYTH_STATE ?? '0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8';
const WORMHOLE_STATE =
  process.env.WORMHOLE_STATE ?? '0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c';

const client = new SuiClient({ url: RPC, network: 'mainnet' });

async function main() {
  console.log(
    `Dry-running Suilend deposit<${COIN.split('::').pop()}> against live mainnet (no funds, no signature)…`
  );

  const tx = new Transaction();
  tx.setSender(ADDR);
  tx.setGasBudget(80_000_000);

  // 0a) Update Pyth on-chain from Hermes signed data (verifies the Wormhole guardians + updates
  //     the PriceInfoObject). This is `pythClient.fetchPythUpdate` feeding the Pyth Sui SDK — the
  //     same signed bytes our enclave-side price verification will consume. Returns the freshened
  //     PriceInfoObject id, which we hand straight to Suilend's reserve refresh.
  const { updateData } = await fetchPythUpdate([FEED_ID]);
  const pyth = new SuiPythClient(client, PYTH_STATE, WORMHOLE_STATE);
  const [priceInfoId] = await pyth.updatePriceFeeds(
    tx,
    updateData.map((b64) => Buffer.from(b64, 'base64')),
    [FEED_ID]
  );
  if (!priceInfoId) throw new Error('Pyth update returned no PriceInfoObject id');

  // 0b) Refresh the reserve price from the now-fresh PriceInfoObject (the on-chain half our
  //     `SuilendClient.addReserveRefresh` wraps). Suilend's deposit aborts (code 1) without it.
  tx.moveCall({
    target: `${PKG}::lending_market::refresh_reserve_price`,
    typeArguments: [MARKET_TYPE],
    arguments: [
      tx.object(LENDING_MARKET),
      tx.pure.u64(RESERVE_INDEX),
      tx.object('0x6'),
      tx.object(priceInfoId)
    ]
  });

  // Split the deposit coin from gas (SUI) — avoids needing a real USDC object.
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(AMOUNT)]);

  // 1) Mint cTokens from the deposited liquidity.
  const ctokens = tx.moveCall({
    target: `${PKG}::lending_market::deposit_liquidity_and_mint_ctokens`,
    typeArguments: [MARKET_TYPE, COIN],
    arguments: [tx.object(LENDING_MARKET), tx.pure.u64(RESERVE_INDEX), tx.object('0x6'), coin]
  });

  // 2) First-ever supply: create the obligation (its ObligationOwnerCap is the withdraw key our
  //    adapter custodies inside the Treasury).
  const obligationCap = tx.moveCall({
    target: `${PKG}::lending_market::create_obligation`,
    typeArguments: [MARKET_TYPE],
    arguments: [tx.object(LENDING_MARKET)]
  });

  // 3) Deposit the cTokens into the obligation (cap passed by &ref).
  tx.moveCall({
    target: `${PKG}::lending_market::deposit_ctokens_into_obligation`,
    typeArguments: [MARKET_TYPE, COIN],
    arguments: [
      tx.object(LENDING_MARKET),
      tx.pure.u64(RESERVE_INDEX),
      obligationCap,
      tx.object('0x6'),
      ctokens
    ]
  });

  // 4) Consume the cap (our adapter custodies it; here we just send it to the sender).
  tx.transferObjects([obligationCap], tx.pure.address(ADDR));

  const built = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: built });

  console.log('\nstatus:', res.effects.status.status);
  if (res.effects.status.status !== 'success') {
    console.log('abort/error:', res.effects.status.error);
    console.log(
      '\n✗ Suilend deposit would FAIL — fix the abort above (stale reserve / wrong index / type args) before going live.'
    );
    return;
  }
  console.log('✓ Suilend deposit would SUCCEED against live mainnet (mint ctokens + obligation + custody).');
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
