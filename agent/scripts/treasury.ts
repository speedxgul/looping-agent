// One-command treasury operations for the non-custodial (attested) flow.
// Reads ALL ids from deployments/mainnet-v2.env — no long inline env vars to assemble.
//
//   bun scripts/treasury.ts status                         # budget + custodied positions
//   bun scripts/treasury.ts create --fund 20 --cap 500     # create+fund, auto-records ids
//   bun scripts/treasury.ts deposit --amount 8             # top up the active treasury
//   bun scripts/treasury.ts withdraw [--submit]            # redeem all treasury positions to owner
//   bun scripts/treasury.ts withdraw --protocol navi --amount 4 --submit
//   bun scripts/treasury.ts withdraw-idle [--amount N]     # recover un-deployed principal to owner
//   bun scripts/treasury.ts wallet-withdraw --protocol navi --amount 3   # Flow-2 wallet position (agent-signed)
//   bun scripts/treasury.ts sync-env                       # push TREASURY_* ids into agent/.env
//
// Treasury ops are owner-signed (the OWNERCAP holder); wallet-withdraw is agent-signed.
// All writes dry-run unless --submit is passed.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import { fromBase64, fromHex } from '@mysten/sui/utils';
import { getPool, updateOraclePriceBeforeUserOperationPTB } from '@naviprotocol/lending';
import { NaviClient } from '../src/clients/chain/naviClient.ts';
import { ScallopClient } from '../src/clients/chain/scallopClient.ts';
import { SuiExecutionClient } from '../src/clients/chain/suiExecutionClient.ts';
import { SuilendClient } from '../src/clients/chain/suilendClient.ts';
import {
  formatEnclaveAttestation,
  formatTreasuryStatus,
  TreasuryClient
} from '../src/clients/chain/treasuryClient.ts';
import {
  buildOwnerRedeemMockTx,
  buildOwnerRedeemNaviTx,
  buildOwnerRedeemScallopTx,
  buildOwnerRedeemSuilendTx
} from '../src/core/ownerRedeemTx.ts';
import { loadConfig } from '../src/utils/config.ts';
import { createLogger } from '../src/utils/logger.ts';

const ENV_PATH = path.resolve(import.meta.dir, '../../deployments/mainnet-v2.env');
const AGENT_ENV_PATH = path.resolve(import.meta.dir, '../.env');
const RPC = process.env.RPC ?? 'https://fullnode.mainnet.sui.io:443';
const USDC_DECIMALS = 6;
const FAR_EXPIRY = '2000000000000';
const DAY_MS = '86400000';

const client = new SuiClient({ url: RPC, network: 'mainnet' });

// ── env file read/write ────────────────────────────────────────────────────
function loadEnv(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}
/** Update existing keys in-place, append missing ones. Preserves comments/order. */
function writeEnv(file: string, updates: Record<string, string>) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const seen = new Set<string>();
  const next = lines.map((l) => {
    const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=/);
    if (m && updates[m[1]] !== undefined) {
      seen.add(m[1]);
      const prefix = l.startsWith('export ') ? 'export ' : '';
      return `${prefix}${m[1]}=${updates[m[1]]}`;
    }
    return l;
  });
  const appended = Object.entries(updates).filter(([k]) => !seen.has(k));
  if (appended.length) {
    next.push('', ...appended.map(([k, v]) => `${k}=${v}`));
  }
  writeFileSync(file, next.join('\n'));
}

const env = loadEnv(ENV_PATH);
const req = (k: string): string => {
  const v = env.get(k) ?? process.env[k];
  if (!v) throw new Error(`missing ${k} in ${ENV_PATH} (or process env)`);
  return v;
};

const CORE = req('CORE_PKG');
const USDC = req('USDC_COIN_TYPE');
const toRaw = (usdc: number) => BigInt(Math.round(usdc * 10 ** USDC_DECIMALS)).toString();
const fmt = (raw: bigint | string, d = USDC_DECIMALS) => (Number(raw) / 10 ** d).toString();

// ── owner signer (keystore) ──────────────────────────────────────────────────
function ownerAddress(): string {
  return env.get('OWNER_ADDR') ?? '0x19aee5602819309c0e206c1acbf97ece9ae189f68b16b4be3eed2483f981be4b';
}
/**
 * The OWNER signer (full authority — distinct from the agent). Resolution order:
 *   1. OWNER_SUI_PRIVATE_KEY env (suiprivkey1… or 0x-hex) — explicit, e.g. for CI / a separate owner.
 *   2. the Sui CLI keystore entry matching OWNER_ADDR — the default for a local operator.
 * (The agent's key — AGENT_SUI_PRIVATE_KEY — is NEVER used here; that one only signs bounded,
 *  enclave-attested supplies in the daemon.)
 */
function loadOwner() {
  const addr = ownerAddress();
  const pk = process.env.OWNER_SUI_PRIVATE_KEY ?? env.get('OWNER_SUI_PRIVATE_KEY');
  if (pk) {
    const kp = pk.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(pk)
      : Ed25519Keypair.fromSecretKey(fromHex(pk.replace(/^0x/, '')));
    if (kp.getPublicKey().toSuiAddress() !== addr)
      throw new Error(
        `OWNER_SUI_PRIVATE_KEY derives ${kp.getPublicKey().toSuiAddress()}, not OWNER_ADDR ${addr}`
      );
    return kp;
  }
  const ks: string[] = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, 'utf8'));
  for (const entry of ks) {
    const raw = fromBase64(entry);
    const kp =
      raw[0] === 0
        ? Ed25519Keypair.fromSecretKey(raw.slice(1))
        : Secp256k1Keypair.fromSecretKey(raw.slice(1));
    if (kp.getPublicKey().toSuiAddress() === addr) return kp;
  }
  throw new Error(`no OWNER_SUI_PRIVATE_KEY set and no keystore key matches OWNER_ADDR ${addr}`);
}

async function runWrite(tx: Transaction, label: string, submit: boolean) {
  const owner = ownerAddress();
  tx.setSender(owner);
  if (!submit) {
    const built = await tx.build({ client });
    const res = await client.dryRunTransactionBlock({ transactionBlock: built });
    console.log(`DRY-RUN ${label}:`, res.effects.status.status);
    if (res.effects.status.status !== 'success') console.log('  abort:', res.effects.status.error);
    else
      for (const b of res.balanceChanges ?? [])
        if (b.coinType.includes('usdc::USDC')) console.log('  would receive', fmt(BigInt(b.amount)), 'USDC');
    console.log('  → re-run with --submit to execute.');
    return;
  }
  const r = await client.signAndExecuteTransaction({
    signer: loadOwner(),
    transaction: tx,
    options: { showEffects: true, showBalanceChanges: true, showObjectChanges: true }
  });
  console.log(`${label} ->`, r.effects?.status?.status, '| tx:', r.digest);
  return r;
}

// ── commands ────────────────────────────────────────────────────────────────
async function cmdStatus() {
  const treasuryId = req('TREASURY');
  const t = new TreasuryClient({
    suiClient: client,
    treasuryId,
    agentCapId: env.get('AGENTCAP') ?? '',
    enclaveUrl: ''
  });
  const b = await t.readBudget(Date.now());
  const pos = await t.readPositions();
  console.log(formatTreasuryStatus({ treasuryId, state: b.state, budget: b, positions: pos }));
  for (const p of pos) console.log(`    - ${p.protocol} (id ${p.protocolId}) receipt ${p.receiptObjectId}`);
}

async function cmdCreate(args: Args) {
  const fund = Number(args.fund ?? '0');
  if (fund <= 0) throw new Error('--fund <usdc> is required (e.g. --fund 20)');
  const capUsdc = Number(args.cap ?? args.fund);
  const perTx = toRaw(Number(args['per-tx'] ?? capUsdc));
  const period = toRaw(Number(args.period ?? capUsdc));
  const agent = req('AGENT_ADDR');

  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::capability::create`,
    typeArguments: [USDC],
    arguments: [
      coinWithBalance({ type: USDC, balance: BigInt(toRaw(fund)) }),
      tx.pure.u64(perTx),
      tx.pure.u64(period),
      tx.pure.u64(DAY_MS),
      tx.pure.u64(FAR_EXPIRY),
      tx.pure.address(agent),
      tx.object('0x6')
    ]
  });
  console.log(
    `create: fund ${fund} USDC | per-tx ${fmt(perTx)} | period ${fmt(period)}/day | agent ${agent}`
  );
  const r = await runWrite(tx, 'create', !!args.submit);
  if (!r) return;
  const created = (r.objectChanges ?? []).filter((c) => c.type === 'created') as Array<{
    objectType: string;
    objectId: string;
  }>;
  const find = (s: string) => created.find((c) => c.objectType.includes(s))?.objectId ?? '';
  const treasury = find('::capability::Treasury<');
  const ownerCap = find('::capability::OwnerCap<');
  const agentCap = find('::capability::AgentCap<');
  console.log('  TREASURY =', treasury, '\n  OWNERCAP =', ownerCap, '\n  AGENTCAP =', agentCap);
  writeEnv(ENV_PATH, { TREASURY: treasury, OWNERCAP: ownerCap, AGENTCAP: agentCap });
  console.log(`  ✓ recorded TREASURY/OWNERCAP/AGENTCAP in ${path.relative(process.cwd(), ENV_PATH)}`);
  console.log('  Next: bun scripts/treasury.ts sync-env   (push into agent/.env), then run-daemon');
}

async function cmdDeposit(args: Args) {
  const amount = Number(args.amount ?? '0');
  if (amount <= 0) throw new Error('--amount <usdc> is required');
  const treasury = req('TREASURY');
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::capability::deposit`,
    typeArguments: [USDC],
    arguments: [tx.object(treasury), coinWithBalance({ type: USDC, balance: BigInt(toRaw(amount)) })]
  });
  console.log(`deposit: ${amount} USDC -> ${treasury}`);
  await runWrite(tx, 'deposit', !!args.submit);
}

/** Build a per-protocol owner_redeem into `tx` (prepending oracle refreshes where needed). */
async function addRedeem(tx: Transaction, protocol: string, amountRaw: bigint) {
  const owner = ownerAddress();
  const base = {
    packageId: '',
    coinType: USDC,
    treasuryId: req('TREASURY'),
    ownerCapId: req('OWNERCAP'),
    ownerAddress: owner
  };
  if (protocol === 'scallop') {
    buildOwnerRedeemScallopTx(
      {
        ...base,
        packageId: req('SCALLOP_ADAPTER_PKG'),
        versionId: req('SCALLOP_VERSION'),
        marketId: req('SCALLOP_MARKET')
      },
      tx
    );
  } else if (protocol === 'mock') {
    buildOwnerRedeemMockTx({ ...base, packageId: req('MOCK_ADAPTER_PKG') }, tx);
  } else if (protocol === 'navi') {
    const pool = await getPool(USDC as never, { env: 'prod' } as never);
    await updateOraclePriceBeforeUserOperationPTB(
      tx as never,
      owner,
      [pool] as never,
      { env: 'prod' } as never
    );
    buildOwnerRedeemNaviTx(
      {
        ...base,
        packageId: req('NAVI_ADAPTER_PKG'),
        oracleId: req('NAVI_ORACLE'),
        storageId: req('NAVI_STORAGE'),
        poolId: req('NAVI_POOL'),
        incentiveV2Id: req('NAVI_INCENTIVE_V2'),
        incentiveV3Id: req('NAVI_INCENTIVE_V3'),
        assetId: Number(req('NAVI_ASSET')),
        amount: amountRaw
      },
      tx
    );
  } else if (protocol === 'suilend') {
    buildOwnerRedeemSuilendTx(
      {
        ...base,
        packageId: req('SUILEND_ADAPTER_PKG'),
        marketType: req('SUILEND_MARKET_TYPE'),
        lendingMarketId: req('SUILEND_LENDING_MARKET'),
        reserveArrayIndex: BigInt(req('SUILEND_RESERVE_INDEX')),
        amount: amountRaw
      },
      tx
    );
  } else throw new Error(`unknown protocol ${protocol}`);
}

async function cmdWithdraw(args: Args) {
  const treasury = req('TREASURY');
  const t = new TreasuryClient({ suiClient: client, treasuryId: treasury, agentCapId: '', enclaveUrl: '' });
  const positions = await t.readPositions();
  const only = args.protocol as string | undefined;
  const targets = only ? positions.filter((p) => p.protocol === only) : positions;
  if (targets.length === 0) {
    console.log('no positions to withdraw', only ? `for ${only}` : '');
    return;
  }
  // scallop/mock redeem the whole position (no amount); navi/suilend need an amount.
  const amountRaw = args.amount ? BigInt(toRaw(Number(args.amount))) : 0n;
  for (const p of targets) {
    if ((p.protocol === 'navi' || p.protocol === 'suilend') && amountRaw === 0n) {
      console.log(`skip ${p.protocol}: needs --amount <usdc> (amount-based withdraw)`);
      continue;
    }
    const tx = new Transaction();
    await addRedeem(tx, p.protocol, amountRaw);
    await runWrite(tx, `withdraw ${p.protocol}`, !!args.submit);
  }
}

/** Withdraw idle (un-deployed) principal from the Treasury back to the owner wallet. */
async function cmdWithdrawIdle(args: Args) {
  const treasury = req('TREASURY');
  const ownerCap = req('OWNERCAP');
  const t = new TreasuryClient({ suiClient: client, treasuryId: treasury, agentCapId: '', enclaveUrl: '' });
  const idleRaw = BigInt((await t.readBudget(Date.now())).state.fundsRaw);
  const amountRaw = args.amount ? BigInt(toRaw(Number(args.amount))) : idleRaw;
  if (amountRaw <= 0n) {
    console.log('no idle principal to withdraw');
    return;
  }
  if (amountRaw > idleRaw) throw new Error(`--amount ${fmt(amountRaw)} exceeds idle ${fmt(idleRaw)} USDC`);
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${CORE}::capability::withdraw_principal`,
    typeArguments: [USDC],
    arguments: [tx.object(treasury), tx.object(ownerCap), tx.pure.u64(amountRaw)]
  });
  tx.transferObjects([coin], ownerAddress());
  console.log(`withdraw-idle: ${fmt(amountRaw)} USDC -> owner ${ownerAddress()}`);
  await runWrite(tx, 'withdraw-idle', !!args.submit);
}

/**
 * Withdraw an agent-WALLET lending position (Flow 2 / non-treasury) back to the agent
 * wallet. Signs with the AGENT key (the wallet that owns the position), not the owner.
 */
async function cmdWalletWithdraw(args: Args) {
  const protocol = String(args.protocol ?? 'navi').toLowerCase();
  const asset = String(args.asset ?? 'usdc').toLowerCase();
  const amountUsdc = Number(args.amount ?? '0');
  if (!(amountUsdc > 0)) throw new Error('--amount <usdc> is required');

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const execution = new SuiExecutionClient({
    rpcUrl: config.sui.rpcUrl,
    network: config.sui.network,
    privateKey: config.sui.privateKey,
    walletAddress: config.agent.walletAddress,
    usdcCoinType: config.sui.usdcCoinType,
    suiCoinType: config.sui.suiCoinType,
    logger
  });
  const lc =
    protocol === 'navi'
      ? new NaviClient({ execution, config, logger })
      : protocol === 'suilend'
        ? new SuilendClient({ execution, config, logger })
        : protocol === 'scallop'
          ? new ScallopClient({ execution, network: config.sui.network, config, logger })
          : null;
  if (!lc) throw new Error(`unknown protocol ${protocol} (use navi|suilend|scallop)`);

  const coinType = lc.resolveCoinType(asset);
  const rawAmount = String(Math.round(amountUsdc * 1e6));
  console.log(
    `wallet-withdraw: ${amountUsdc} ${asset} from ${protocol} -> agent ${config.agent.walletAddress}`
  );
  if (!args.submit) {
    console.log('  → re-run with --submit to execute (signs with the agent key).');
    return;
  }
  const res = await lc.executeWithdraw({ coinType, rawAmount, asset });
  console.log('wallet-withdraw ->', res.digest ?? JSON.stringify(res));
}

/** Print the TEE attestation banner: registered signing key + on-chain PCR measurements. */
async function cmdAttest() {
  const t = new TreasuryClient({
    suiClient: client,
    treasuryId: env.get('TREASURY') ?? '',
    agentCapId: env.get('AGENTCAP') ?? '',
    enclaveUrl: env.get('ENCLAVE_IP') ? `http://${env.get('ENCLAVE_IP')}:3000` : '',
    enclaveId: req('ENCLAVE_OBJECT'),
    enclaveConfigId: req('CONFIG')
  });
  const att = await t.readEnclaveAttestation();
  if (!att) {
    console.log('no enclave found (need ENCLAVE_OBJECT in deployments/mainnet-v2.env)');
    return;
  }
  console.log(formatEnclaveAttestation(att, { enclaveUrl: t.enclaveUrl }));
}

function cmdSyncEnv() {
  const map: Record<string, string> = {
    TREASURY_MODE: 'true',
    TREASURY_PACKAGE_ID: req('CORE_PKG'),
    TREASURY_MOCK_ADAPTER_PKG: req('MOCK_ADAPTER_PKG'),
    TREASURY_REGISTRY_ID: req('REGISTRY'),
    TREASURY_ID: req('TREASURY'),
    TREASURY_AGENT_CAP_ID: req('AGENTCAP'),
    TREASURY_ENCLAVE_OBJECT_ID: req('ENCLAVE_OBJECT'),
    TREASURY_ENCLAVE_CONFIG_ID: req('CONFIG'),
    TREASURY_ENCLAVE_URL: `http://${req('ENCLAVE_IP')}:3000`,
    TREASURY_SCALLOP_ADAPTER_PKG: req('SCALLOP_ADAPTER_PKG'),
    TREASURY_SCALLOP_VERSION_ID: req('SCALLOP_VERSION'),
    TREASURY_SCALLOP_MARKET_ID: req('SCALLOP_MARKET'),
    TREASURY_NAVI_ADAPTER_PKG: req('NAVI_ADAPTER_PKG'),
    TREASURY_NAVI_STORAGE_ID: req('NAVI_STORAGE'),
    TREASURY_NAVI_POOL_ID: req('NAVI_POOL'),
    TREASURY_NAVI_INCENTIVE_V2_ID: req('NAVI_INCENTIVE_V2'),
    TREASURY_NAVI_INCENTIVE_V3_ID: req('NAVI_INCENTIVE_V3'),
    TREASURY_NAVI_ASSET_ID: req('NAVI_ASSET'),
    TREASURY_SUILEND_ADAPTER_PKG: req('SUILEND_ADAPTER_PKG'),
    TREASURY_SUILEND_MARKET_TYPE: req('SUILEND_MARKET_TYPE'),
    TREASURY_SUILEND_LENDING_MARKET_ID: req('SUILEND_LENDING_MARKET'),
    TREASURY_SUILEND_RESERVE_INDEX: req('SUILEND_RESERVE_INDEX'),
    TREASURY_SUILEND_PYTH_PRICE_INFO_ID: req('SUILEND_PYTH_PRICE_INFO')
  };
  writeEnv(AGENT_ENV_PATH, map);
  console.log(
    `✓ synced ${Object.keys(map).length} TREASURY_* vars into agent/.env (TREASURY_ID=${map.TREASURY_ID})`
  );
}

// ── arg parsing + dispatch ────────────────────────────────────────────────────
type Args = Record<string, string | boolean | undefined>;
function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? 'status';
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const hasVal = argv[i + 1] && !argv[i + 1].startsWith('--');
    args[key] = hasVal ? argv[i + 1] : true;
    if (hasVal) i += 1;
  }
  return { cmd, args };
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'create':
      return cmdCreate(args);
    case 'deposit':
      return cmdDeposit(args);
    case 'withdraw':
      return cmdWithdraw(args);
    case 'withdraw-idle':
      return cmdWithdrawIdle(args);
    case 'wallet-withdraw':
      return cmdWalletWithdraw(args);
    case 'attest':
      return cmdAttest();
    case 'sync-env':
      return cmdSyncEnv();
    default:
      console.log(
        'commands: status | create --fund N [--cap N] | deposit --amount N | withdraw [--protocol p --amount N] [--submit] | withdraw-idle [--amount N] [--submit] | wallet-withdraw --protocol navi --amount N [--submit] | attest | sync-env'
      );
      console.log('writes are DRY-RUN unless --submit is passed.');
  }
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
