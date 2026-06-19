import { NaviClient } from '../src/clients/chain/naviClient.js';
import { ScallopClient } from '../src/clients/chain/scallopClient.js';
import { SuiExecutionClient } from '../src/clients/chain/suiExecutionClient.js';
import { SuilendClient } from '../src/clients/chain/suilendClient.js';
import { loadConfig } from '../src/utils/config.js';
import { createLogger } from '../src/utils/logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('Checking lending rates', { network: config.sui.network });

  const execution = new SuiExecutionClient({
    rpcUrl: config.sui.rpcUrl,
    network: config.sui.network,
    privateKey: config.sui.privateKey,
    walletAddress: config.agent.walletAddress,
    usdcCoinType: config.sui.usdcCoinType,
    suiCoinType: config.sui.suiCoinType,
    logger
  });

  const suilend = new SuilendClient({ execution, config, logger });
  const navi = new NaviClient({ execution, config, logger });
  const scallop = new ScallopClient({ execution, network: config.sui.network, config, logger });

  const { markets } = await suilend.getMarkets();
  console.log('\n=== Suilend markets (allowlisted, ranked by APR) ===');
  console.table(
    markets.map((m) => ({
      symbol: m.symbol,
      supplyApr: `${m.supplyApr.toFixed(2)}%`,
      borrowApr: `${m.borrowApr.toFixed(2)}%`,
      price: `$${m.price.toFixed(4)}`,
      coinType: m.coinType
    }))
  );

  const assets = config.sui.allowedAssets.length > 0 ? config.sui.allowedAssets : ['usdc', 'sui'];

  if (navi.enabled) {
    console.log('\n=== NAVI rates ===');
    console.log(JSON.stringify(await navi.getRates(assets), null, 2));
  } else {
    console.log('\nNAVI reads disabled (set ENABLE_NAVI_READS=true to compare).');
  }

  if (scallop.enabled) {
    console.log('\n=== Scallop rates ===');
    console.log(JSON.stringify(await scallop.getRates(assets), null, 2));
  } else {
    console.log('\nScallop reads disabled (set ENABLE_SCALLOP_READS=true to compare).');
  }
}

main().catch((error) => {
  console.error('Rate check failed:', error);
  process.exit(1);
});
