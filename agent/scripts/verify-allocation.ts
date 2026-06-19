/**
 * Read-only verification of the allocation solver. Fetches each protocol's live
 * USDC reserve curve, prints it, then runs the water-filling solver and compares
 * the optimal split against the naive "dump everything in the top spot rate"
 * heuristic. Signs nothing and moves no funds.
 *
 *   SUI_NETWORK=mainnet bun scripts/verify-allocation.ts
 *
 * Optional: override the budget (human USDC) to see own-impact at larger sizes
 * even with an empty wallet, and include non-write-enabled protocols:
 *
 *   ALLOC_BUDGET_USDC=250000 INCLUDE_ALL=1 SUI_NETWORK=mainnet bun scripts/verify-allocation.ts
 */
import { NaviClient } from '../src/clients/chain/naviClient.js';
import { ScallopClient } from '../src/clients/chain/scallopClient.js';
import { SuiExecutionClient } from '../src/clients/chain/suiExecutionClient.js';
import { SuilendClient } from '../src/clients/chain/suilendClient.js';
import {
  netSupplyApr,
  type ReserveCurve,
  solveAllocation,
  supplyApr,
  utilizationAfterDeposit
} from '../src/core/allocation.js';
import type { LendingProtocol, LendingProtocolClient } from '../src/types.js';
import { formatUnits, parseUnits } from '../src/utils/amounts.js';
import { loadConfig } from '../src/utils/config.js';
import { createLogger } from '../src/utils/logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger('warn');
  const owner = config.agent.walletAddress;
  const includeAll = process.env.INCLUDE_ALL === '1';

  const execution = new SuiExecutionClient({
    rpcUrl: config.sui.rpcUrl,
    network: config.sui.network,
    privateKey: config.sui.privateKey,
    walletAddress: owner,
    usdcCoinType: config.sui.usdcCoinType,
    suiCoinType: config.sui.suiCoinType,
    logger
  });

  const clients: Record<LendingProtocol, LendingProtocolClient> = {
    suilend: new SuilendClient({ execution, config, logger }),
    navi: new NaviClient({ execution, config, logger }),
    scallop: new ScallopClient({ execution, network: config.sui.network, config, logger })
  };

  console.log(`\nNetwork: ${config.sui.network}`);
  console.log(`Wallet:  ${owner || '(none)'}\n`);

  const usdcAsset = config.sui.defaultAssets.usdc;
  const curves: ReserveCurve[] = [];

  for (const protocol of ['suilend', 'navi', 'scallop'] as LendingProtocol[]) {
    const eligible =
      Boolean(config.sui.protocols[protocol]?.write) && config.sui.allowedProtocols.includes(protocol);
    const client = clients[protocol];
    const coinType = client.resolveCoinType(usdcAsset);

    let curve: ReserveCurve | undefined;
    try {
      const { markets } = await client.getMarkets();
      curve = markets.find((m) => sameCoinType(m.coinType, coinType))?.curve;
    } catch (error) {
      console.log(`=== ${protocol} === getMarkets failed: ${(error as Error).message}\n`);
      continue;
    }

    console.log(`=== ${protocol} (USDC) ${eligible ? '[eligible]' : '[not write/allowlisted]'} ===`);
    if (!curve) {
      console.log('  no reserve curve available\n');
      continue;
    }

    const u0 = utilizationAfterDeposit(curve, 0n);
    console.log(
      `  utilization=${(u0 * 100).toFixed(2)}%  reserveFactor=${curve.reserveFactorPct.toFixed(2)}%  ` +
        `spotSupply=${supplyApr(curve, u0).toFixed(3)}%  reward=${curve.rewardSupplyApr.toFixed(3)}%  ` +
        `netSpot=${netSupplyApr(curve, 0n).toFixed(3)}%`
    );
    console.log(
      `  liquidity: borrowed=${fmtRaw(curve.borrowedRaw, curve.decimals)} available=${fmtRaw(curve.availableLiquidityRaw, curve.decimals)} cap=${curve.depositCapRaw ? fmtRaw(curve.depositCapRaw, curve.decimals) : '(none)'}`
    );
    console.log(
      `  borrowAprPoints: ${curve.borrowAprPoints.map((p) => `(${(p.util * 100).toFixed(0)}%→${p.apr.toFixed(2)}%)`).join(' ')}\n`
    );

    if (eligible || includeAll) {
      curves.push(curve);
    }
  }

  if (curves.length === 0) {
    console.log('No curves to allocate across. (Enable writes/allowlist or set INCLUDE_ALL=1.)\n');
    return;
  }

  // Budget: env override (human USDC) or the wallet balance capped by maxSupplyRaw.
  let budgetRaw: bigint;
  if (process.env.ALLOC_BUDGET_USDC) {
    budgetRaw = parseUnits(process.env.ALLOC_BUDGET_USDC, 6);
  } else {
    const usdcRaw = owner ? BigInt((await execution.getCoinBalances(owner)).usdc.raw) : 0n;
    budgetRaw = usdcRaw < config.sui.maxSupplyRaw ? usdcRaw : config.sui.maxSupplyRaw;
  }

  console.log(`=== allocation (budget ${fmtRaw(budgetRaw.toString(), 6)} USDC) ===`);
  if (budgetRaw <= 0n) {
    console.log('  budget is 0 — set ALLOC_BUDGET_USDC to test, e.g. ALLOC_BUDGET_USDC=100000\n');
    return;
  }

  const result = solveAllocation({
    curves,
    budgetRaw,
    perProtocolCapRaw: config.sui.maxSupplyRaw,
    minPositionRaw: config.sui.minIdleRaw > 0n ? config.sui.minIdleRaw : undefined
  });

  for (const leg of result.allocations) {
    console.log(
      `  ${leg.protocol.padEnd(8)} ${fmtRaw(leg.xRaw, 6).padStart(14)} USDC  ` +
        `(${(leg.share * 100).toFixed(1)}%)  netApr=${leg.netSupplyApr.toFixed(3)}%`
    );
  }

  const naive = [...curves].sort((a, b) => netSupplyApr(b, 0n) - netSupplyApr(a, 0n))[0];
  const naiveApr = naive ? netSupplyApr(naive, budgetRaw) : 0;
  console.log('');
  console.log(
    `  blendedNetApr = ${result.blendedNetApr.toFixed(4)}%   marginalApr = ${result.marginalApr.toFixed(4)}%`
  );
  console.log(
    `  naive (all into ${naive?.protocol}) = ${naiveApr.toFixed(4)}%   improvement = ${Math.round((result.blendedNetApr - naiveApr) * 100)} bps`
  );
  console.log(
    `  allocated = ${fmtRaw(result.allocatedRaw, 6)}  unallocated = ${fmtRaw(result.unallocatedRaw, 6)}  iterations = ${result.iterations}\n`
  );
}

function fmtRaw(raw: string, decimals: number): string {
  return formatUnits(raw, decimals);
}

function sameCoinType(a: string, b: string): boolean {
  const norm = (v: string) => {
    const withPrefix = v.includes('::') && !v.startsWith('0x') ? `0x${v}` : v;
    return withPrefix.toLowerCase();
  };
  return norm(a) === norm(b);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
