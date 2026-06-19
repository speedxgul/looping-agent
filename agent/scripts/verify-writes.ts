/**
 * LIVE write verification: for each protocol, supply a tiny amount of SUI and then
 * withdraw it, printing transaction digests. Spends gas and briefly moves funds.
 * Deterministic (no LLM). Calls the protocol clients directly.
 *
 *   SUI_NETWORK=mainnet bun scripts/verify-writes.ts                # default 0.1 SUI
 *   SUI_NETWORK=mainnet PROTOCOLS=navi,scallop AMOUNT=100000000 bun scripts/verify-writes.ts
 */
import { NaviClient } from '../src/clients/chain/naviClient.js';
import { ScallopClient } from '../src/clients/chain/scallopClient.js';
import { SuiExecutionClient } from '../src/clients/chain/suiExecutionClient.js';
import { SuilendClient } from '../src/clients/chain/suilendClient.js';
import type { LendingProtocol, LendingProtocolClient } from '../src/types.js';
import { loadConfig } from '../src/utils/config.js';
import { createLogger } from '../src/utils/logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger('info');
  const owner = config.agent.walletAddress;
  const suiCoinType = config.sui.suiCoinType;

  const rawAmount = process.env.AMOUNT ?? '100000000'; // 0.1 SUI (9 decimals)
  const protocols = (process.env.PROTOCOLS ?? 'suilend,navi,scallop')
    .split(',')
    .map((p) => p.trim().toLowerCase()) as LendingProtocol[];

  const execution = new SuiExecutionClient({
    rpcUrl: config.sui.rpcUrl,
    network: config.sui.network,
    privateKey: config.sui.privateKey,
    walletAddress: owner,
    usdcCoinType: config.sui.usdcCoinType,
    suiCoinType,
    logger
  });

  const clients: Record<LendingProtocol, LendingProtocolClient> = {
    suilend: new SuilendClient({ execution, config, logger }),
    navi: new NaviClient({ execution, config, logger }),
    scallop: new ScallopClient({ execution, network: config.sui.network, config, logger })
  };

  await execution.assertWalletMatches();
  const before = await execution.getCoinBalances(owner);
  console.log(`\nNetwork: ${config.sui.network}  Wallet: ${owner}`);
  console.log(`Start balance: ${before.sui.formatted} SUI`);
  console.log(`Test amount: ${rawAmount} (raw SUI)  Protocols: ${protocols.join(', ')}\n`);

  const results: Record<string, { supply?: string; withdraw?: string; error?: string }> = {};

  for (const protocol of protocols) {
    const client = clients[protocol];
    results[protocol] = {};
    console.log(`=== ${protocol}: supply ${rawAmount} SUI ===`);
    try {
      const positions = await client.getPositions(owner);
      const supply = await client.executeSupply({
        coinType: suiCoinType,
        asset: 'sui',
        rawAmount,
        positions
      });
      results[protocol].supply = supply.digest;
      console.log(`  supply digest: ${supply.digest}`);

      // Re-read positions so withdraw uses current obligation handles.
      const after = await client.getPositions(owner);
      console.log(
        `  post-supply: deposits=${after.deposits.length} suppliedUsd=$${after.depositedAmountUsd.toFixed(4)}`
      );

      console.log(`  withdraw ${rawAmount} SUI ...`);
      const withdraw = await client.executeWithdraw({
        coinType: suiCoinType,
        asset: 'sui',
        rawAmount,
        positions: after
      });
      results[protocol].withdraw = withdraw.digest;
      console.log(`  withdraw digest: ${withdraw.digest}`);
    } catch (error) {
      const message = (error as Error).message;
      results[protocol].error = message;
      console.log(`  ERROR: ${message}`);
    }
    console.log('');
  }

  const end = await execution.getCoinBalances(owner);
  console.log(`End balance: ${end.sui.formatted} SUI (gas + any rounding dust)\n`);
  console.log('=== Summary ===');
  for (const [protocol, r] of Object.entries(results)) {
    const status = r.error
      ? `FAILED (${r.error})`
      : `supply ${short(r.supply)} / withdraw ${short(r.withdraw)}`;
    console.log(`  ${protocol}: ${status}`);
  }
  console.log('');
}

function short(digest?: string): string {
  return digest ? `${digest.slice(0, 10)}…` : 'none';
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
