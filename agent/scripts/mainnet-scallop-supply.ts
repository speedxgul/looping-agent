// LIVE mainnet attested Scallop supply (the round-trip's supply half).
// agent → enclave /decide (signs the allocation) → verified_supply_scallop_entry → custody.
// Dry-runs first (no gas); pass SUBMIT=1 to execute for real with the agent key.
//
//   source deployments/mainnet.env && cd agent && bun scripts/mainnet-scallop-supply.ts
//   ... SUBMIT=1 bun scripts/mainnet-scallop-supply.ts   (real)
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';
import { TreasuryClient } from '../src/clients/chain/treasuryClient.ts';
import { buildVerifiedAllocationTx, type VerifiedSupplyScallopRefs } from '../src/core/verifiedSupplyTx.ts';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`missing env var ${k}`);
  return v;
};

const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
const PKG = env('PKG');
const TREASURY = env('TREASURY');
const AGENTCAP = env('AGENTCAP');
const ENCLAVE = env('ENCLAVE');
const REGISTRY = env('REGISTRY');
const USDC = env('USDC_COIN_TYPE');
const ENCLAVE_URL = `http://${env('ENCLAVE_IP')}:3000`;
const AGENT_ADDR = env('AGENT_ADDR');
const SCALLOP_VERSION = env('SCALLOP_VERSION');
const SCALLOP_MARKET = env('SCALLOP_MARKET');

const client = new SuiClient({ url: RPC, network: 'mainnet' });

async function main() {
  const treasury = new TreasuryClient({
    suiClient: client,
    treasuryId: TREASURY,
    agentCapId: AGENTCAP,
    enclaveUrl: ENCLAVE_URL
  });

  // What the vault lets us deploy right now.
  const budget = await treasury.readBudget(Date.now());
  console.log('budget:', {
    deployable: budget.deployableRaw.toString(),
    perTxCap: budget.state.perTxCapRaw.toString(),
    canSupply: budget.canSupply,
    reason: budget.reason
  });
  if (!budget.canSupply) throw new Error(`cannot supply: ${budget.reason}`);

  // A Scallop USDC reserve curve for the enclave's optimizer (it allocates the budget, clamps
  // each leg to the per-tx cap, and SIGNS the chosen ActionIntent inside the TEE).
  const curve = {
    protocol: 'scallop',
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
  const legs = await treasury.decide({
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
    'enclave signed legs:',
    legs.map((l) => ({ protocolId: l.intent.protocolId, amount: l.intent.amount.toString(), nonce: l.intent.nonce.toString() }))
  );
  const scallopLegs = legs.filter((l) => l.intent.protocolId === 1);
  if (scallopLegs.length === 0) throw new Error('enclave did not return a Scallop leg');

  const refs: VerifiedSupplyScallopRefs = {
    packageId: PKG,
    coinType: USDC,
    registryId: REGISTRY,
    treasuryId: TREASURY,
    enclaveId: ENCLAVE,
    agentCapId: AGENTCAP,
    versionId: SCALLOP_VERSION,
    marketId: SCALLOP_MARKET
  };
  const tx = buildVerifiedAllocationTx(scallopLegs, { scallop: refs }, TS);
  tx.setSender(AGENT_ADDR);

  if (process.env.SUBMIT === '1') {
    // The agent key (Phantom) lives in agent/.env, auto-loaded by bun.
    const pk = env('AGENT_SUI_PRIVATE_KEY');
    const signer = pk.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(pk)
      : Ed25519Keypair.fromSecretKey(fromHex(pk.replace(/^0x/, '')));
    if (signer.getPublicKey().toSuiAddress() !== AGENT_ADDR)
      throw new Error(`AGENT_SUI_PRIVATE_KEY derives ${signer.getPublicKey().toSuiAddress()}, not AGENT_ADDR ${AGENT_ADDR}`);
    const r = await client.signAndExecuteTransaction({ signer, transaction: tx, options: { showEffects: true, showBalanceChanges: true } });
    console.log('\nSUPPLY ->', r.effects?.status, '| tx:', r.digest);
    for (const b of r.balanceChanges ?? []) console.log('  ', b.coinType.split('::').pop(), b.amount, '->', b.owner);
  } else {
    const built = await tx.build({ client });
    const res = await client.dryRunTransactionBlock({ transactionBlock: built });
    console.log('\nDRY-RUN status:', res.effects.status.status);
    if (res.effects.status.status !== 'success') console.log('abort:', res.effects.status.error);
    else console.log('✓ would supply to real Scallop. Re-run with SUBMIT=1 to execute.');
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
