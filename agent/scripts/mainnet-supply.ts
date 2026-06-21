// Generalized LIVE mainnet attested supply for the SPLIT architecture — works for
// scallop | navi | suilend. agent → enclave /decide (signs in the TEE) → the protocol's
// verified_supply_*_entry (in its own adapter package) → custody.
//
// Dry-runs first (no gas); pass SUBMIT=1 to execute with the agent key.
//
//   source deployments/mainnet-v2.env && cd agent && PROTOCOL=navi    bun scripts/mainnet-supply.ts
//   source deployments/mainnet-v2.env && cd agent && PROTOCOL=suilend bun scripts/mainnet-supply.ts
//   ... SUBMIT=1 PROTOCOL=navi bun scripts/mainnet-supply.ts   (real)
import { SuiClient } from '@mysten/sui/client';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE, SuilendClient } from '@suilend/sdk';
import { TreasuryClient } from '../src/clients/chain/treasuryClient.ts';
import { type AllocationRefs, buildVerifiedAllocationTx } from '../src/core/verifiedSupplyTx.ts';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const PROTOCOL = (process.env.PROTOCOL ?? 'scallop').toLowerCase();
const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
const TREASURY = env('TREASURY');
const AGENTCAP = env('AGENTCAP');
const ENCLAVE = env('ENCLAVE');
const REGISTRY = env('REGISTRY');
const USDC = env('USDC_COIN_TYPE');
const ENCLAVE_IP = env('ENCLAVE_IP');
const ENCLAVE_URL = `http://${ENCLAVE_IP}:3000`;
const AGENT_ADDR = env('AGENT_ADDR');

const PROTOCOL_ID: Record<string, number> = { suilend: 0, scallop: 1, navi: 2 };
if (!(PROTOCOL in PROTOCOL_ID)) throw new Error(`PROTOCOL must be scallop|navi|suilend (got ${PROTOCOL})`);

const client = new SuiClient({ url: RPC, network: 'mainnet' });

/** Per-protocol allocation refs, sourced from deployments/mainnet-v2.env. */
function refsFor(): AllocationRefs {
  const base = {
    coinType: USDC,
    registryId: REGISTRY,
    treasuryId: TREASURY,
    enclaveId: ENCLAVE,
    agentCapId: AGENTCAP
  };
  if (PROTOCOL === 'scallop')
    return {
      scallop: {
        ...base,
        packageId: env('SCALLOP_ADAPTER_PKG'),
        versionId: env('SCALLOP_VERSION'),
        marketId: env('SCALLOP_MARKET')
      }
    };
  if (PROTOCOL === 'navi')
    return {
      navi: {
        ...base,
        packageId: env('NAVI_ADAPTER_PKG'),
        storageId: env('NAVI_STORAGE'),
        poolId: env('NAVI_POOL'),
        incentiveV2Id: env('NAVI_INCENTIVE_V2'),
        incentiveV3Id: env('NAVI_INCENTIVE_V3'),
        assetId: Number(env('NAVI_ASSET'))
      }
    };
  return {
    suilend: {
      ...base,
      packageId: env('SUILEND_ADAPTER_PKG'),
      marketType: env('SUILEND_MARKET_TYPE'),
      lendingMarketId: env('SUILEND_LENDING_MARKET'),
      reserveArrayIndex: BigInt(env('SUILEND_RESERVE_INDEX')),
      pythPriceInfoObjectId: env('SUILEND_PYTH_PRICE_INFO')
    }
  };
}

async function main() {
  console.log(`\n=== ${PROTOCOL.toUpperCase()} supply through the split path (mainnet) ===`);
  const treasury = new TreasuryClient({
    suiClient: client,
    treasuryId: TREASURY,
    agentCapId: AGENTCAP,
    enclaveUrl: ENCLAVE_URL
  });

  const budget = await treasury.readBudget(Date.now());
  console.log('budget:', {
    deployable: budget.deployableRaw.toString(),
    perTxCap: budget.state.perTxCapRaw.toString(),
    canSupply: budget.canSupply
  });
  if (!budget.canSupply) throw new Error(`cannot supply: ${budget.reason}`);

  // A reserve curve so the TEE optimizer allocates the budget to THIS protocol (the only curve given).
  const curve = {
    protocol: PROTOCOL,
    asset: 'USDC',
    coinType: USDC,
    borrowAprPoints: [
      { util: 0, apr: 1 },
      { util: 0.8, apr: 5 },
      { util: 1, apr: 20 }
    ],
    reserveFactorPct: 20,
    borrowedRaw: '1000000000',
    availableLiquidityRaw: '5000000000',
    depositCapRaw: '100000000000',
    decimals: 6,
    price: 1.0,
    rewardSupplyApr: 0.02
  };

  const TS = BigInt(Date.now());
  const decided = await treasury.decide({
    curves: [curve],
    depositRaw: budget.deployableRaw,
    perTxCapRaw: budget.state.perTxCapRaw,
    nonce: BigInt(Date.now()),
    expiresAtMs: BigInt(Date.now() + 600_000),
    assetType: Array.from(new TextEncoder().encode('USDC')),
    chainId: [4],
    timestampMs: TS
  });

  console.log(
    'TEE key:',
    `0x${decided.publicKey.replace(/^0x/, '')}`,
    '| match on-chain:',
    (await client.getObject({ id: ENCLAVE, options: { showContent: true } })).data?.content
      ? '(checked)'
      : '?'
  );

  const want = PROTOCOL_ID[PROTOCOL];
  const legs = decided.legs.filter((l) => l.intent.protocolId === want);
  if (legs.length === 0)
    throw new Error(
      `enclave returned no ${PROTOCOL} leg (got protocolIds ${decided.legs.map((l) => l.intent.protocolId)})`
    );
  for (const l of legs)
    console.log(`  leg: protocol ${l.intent.protocolId} amount ${l.intent.amount} nonce ${l.intent.nonce}`);

  // Suilend deposit recomputes ctoken value vs the reserve price and aborts if stale, so
  // prepend a Pyth refresh_reserve_price in the SAME PTB (PTB commands run in order).
  const tx = new Transaction();
  if (PROTOCOL === 'suilend') {
    const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: RPC });
    const sclient = await SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, grpc as never);
    await sclient.refreshReservePrices(
      tx as never,
      env('SUILEND_PYTH_PRICE_INFO'),
      BigInt(env('SUILEND_RESERVE_INDEX'))
    );
    console.log('  (prepended Suilend reserve price refresh)');
  }

  buildVerifiedAllocationTx(legs, refsFor(), TS, tx);
  tx.setSender(AGENT_ADDR);

  if (process.env.SUBMIT === '1') {
    const pk = env('AGENT_SUI_PRIVATE_KEY');
    const signer = pk.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(pk)
      : Ed25519Keypair.fromSecretKey(fromHex(pk.replace(/^0x/, '')));
    if (signer.getPublicKey().toSuiAddress() !== AGENT_ADDR)
      throw new Error('AGENT_SUI_PRIVATE_KEY does not derive AGENT_ADDR');
    const r = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showEffects: true, showBalanceChanges: true }
    });
    console.log(`\n${PROTOCOL} SUPPLY ->`, r.effects?.status, '| tx:', r.digest);
    for (const b of r.balanceChanges ?? [])
      console.log('  ', b.coinType.split('::').pop(), b.amount, '->', b.owner);
  } else {
    const built = await tx.build({ client });
    const res = await client.dryRunTransactionBlock({ transactionBlock: built });
    console.log(`\nDRY-RUN status: ${res.effects.status.status}`);
    if (res.effects.status.status !== 'success') console.log('abort:', res.effects.status.error);
    else console.log(`✓ would supply to real ${PROTOCOL} + custody. Re-run with SUBMIT=1 to execute.`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
