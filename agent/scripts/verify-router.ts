/**
 * Read-only verification of the multi-protocol yield router. Exercises the new
 * getPositions / getMarkets paths on Suilend, NAVI, and Scallop and computes the
 * best supply target. Signs nothing and moves no funds.
 *
 *   SUI_NETWORK=mainnet bun scripts/verify-router.ts
 */
import { normalizeStructTag } from '@mysten/sui/utils';
import { NaviClient } from '../src/clients/chain/naviClient.js';
import { ScallopClient } from '../src/clients/chain/scallopClient.js';
import { SuiExecutionClient } from '../src/clients/chain/suiExecutionClient.js';
import { SuilendClient } from '../src/clients/chain/suilendClient.js';
import type { LendingProtocol, LendingProtocolClient } from '../src/types.js';
import { loadConfig } from '../src/utils/config.js';
import { createLogger } from '../src/utils/logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger('warn');
  const owner = config.agent.walletAddress;

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
  console.log(`Wallet:  ${owner}\n`);

  const balances = await execution.getCoinBalances(owner);
  console.log(`Balances: ${balances.sui.formatted} SUI, ${balances.usdc.formatted} USDC\n`);

  const assets = [config.sui.defaultAssets.usdc, config.sui.defaultAssets.sui];
  const candidates: Array<{ protocol: LendingProtocol; asset: string; supplyApr: number }> = [];

  for (const protocol of ['suilend', 'navi', 'scallop'] as LendingProtocol[]) {
    const client = clients[protocol];
    console.log(`=== ${protocol} ===`);

    try {
      const { markets } = await client.getMarkets();
      for (const asset of assets) {
        const coinType = client.resolveCoinType(asset);
        const market = markets.find((m) => sameCoinType(m.coinType, coinType));
        if (market) {
          console.log(
            `  market ${asset.padEnd(5)} supplyApr=${market.supplyApr.toFixed(2)}% borrowApr=${market.borrowApr.toFixed(2)}% price=$${market.price.toFixed(4)}`
          );
          candidates.push({ protocol, asset, supplyApr: market.supplyApr });
        }
      }
    } catch (error) {
      console.log(`  getMarkets failed: ${(error as Error).message}`);
    }

    try {
      const positions = await client.getPositions(owner);
      console.log(
        `  positions: HF=${fmtHf(positions.healthFactor)} deposits=${positions.deposits.length} borrows=${positions.borrows.length} suppliedUsd=$${positions.depositedAmountUsd.toFixed(2)} borrowedUsd=$${positions.borrowedAmountUsd.toFixed(2)}`
      );
      if (positions.obligationId) {
        console.log(`  obligationId: ${positions.obligationId}`);
      }
    } catch (error) {
      console.log(`  getPositions failed: ${(error as Error).message}`);
    }
    console.log('');
  }

  candidates.sort((a, b) => b.supplyApr - a.supplyApr);
  const best = candidates[0];
  const runnerUp = candidates.find((c) => best && (c.protocol !== best.protocol || c.asset !== best.asset));
  console.log('=== best supply target ===');
  if (best) {
    console.log(`  best: ${best.protocol} ${best.asset} @ ${best.supplyApr.toFixed(2)}%`);
    if (runnerUp) {
      const deltaBps = Math.round((best.supplyApr - runnerUp.supplyApr) * 100);
      console.log(
        `  runnerUp: ${runnerUp.protocol} ${runnerUp.asset} @ ${runnerUp.supplyApr.toFixed(2)}% (delta ${deltaBps}bps, threshold ${config.sui.rebalanceMinAprDeltaBps}bps)`
      );
    }
  } else {
    console.log('  (no candidates)');
  }
  console.log('');
}

function fmtHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(3) : '∞';
}

function sameCoinType(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: string): string {
  const withPrefix = value.includes('::') && !value.startsWith('0x') ? `0x${value}` : value;
  try {
    return normalizeStructTag(withPrefix).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
