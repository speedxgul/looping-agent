import { SuiClient } from '@mysten/sui/client';
import { NaviClient } from './clients/chain/naviClient.js';
import { ScallopClient } from './clients/chain/scallopClient.js';
import { SuiExecutionClient } from './clients/chain/suiExecutionClient.js';
import { SuilendClient } from './clients/chain/suilendClient.js';
import { TreasuryClient } from './clients/chain/treasuryClient.js';
import { OpenAIResponsesClient } from './clients/http/openaiResponsesClient.js';
import { XClient } from './clients/http/xClient.js';
import { WalrusBlobClient } from './clients/storage/walrusBlobClient.js';
import { WalrusMemoryClient } from './clients/storage/walrusMemoryClient.js';
import { createAutonomousAgent } from './core/autonomousAgent.js';
import type { AppConfig, Clients, Logger } from './types.js';
import { loadConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { describeSuiPrivateKeyConfig } from './utils/privateKey.js';

async function main() {
  const command = process.argv[2] || 'run-once';
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const suiExecution = new SuiExecutionClient({
    rpcUrl: config.sui.rpcUrl,
    network: config.sui.network,
    privateKey: config.sui.privateKey,
    walletAddress: config.agent.walletAddress,
    usdcCoinType: config.sui.usdcCoinType,
    suiCoinType: config.sui.suiCoinType,
    logger
  });

  const clients: Clients = {
    suiExecution,
    suilend: new SuilendClient({
      execution: suiExecution,
      config,
      logger
    }),
    navi: new NaviClient({
      execution: suiExecution,
      config,
      logger
    }),
    scallop: new ScallopClient({
      execution: suiExecution,
      network: config.sui.network,
      config,
      logger
    }),
    // Non-custodial path: present only when treasury mode is configured. The agent reads
    // the vault budget + custodied positions and relays enclave-signed allocations.
    treasury:
      config.treasury.enabled && config.treasury.treasuryId
        ? new TreasuryClient({
            suiClient: new SuiClient({ url: config.sui.rpcUrl, network: config.sui.network }),
            treasuryId: config.treasury.treasuryId,
            agentCapId: config.treasury.agentCapId,
            enclaveUrl: config.treasury.enclaveUrl
          })
        : null,
    openai: new OpenAIResponsesClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      logger
    }),
    x: new XClient({
      apiBase: config.x.apiBase,
      userAccessToken: config.x.userAccessToken,
      logger
    }),
    walrusBlob: new WalrusBlobClient({
      publisherUrl: config.walrus.publisherUrl,
      aggregatorUrl: config.walrus.aggregatorUrl,
      epochs: config.walrus.epochs,
      logger
    }),
    walrusMemory: new WalrusMemoryClient({
      enabled: config.walrus.memwal.enabled,
      accountId: config.walrus.memwal.accountId,
      delegateKey: config.walrus.memwal.delegateKey,
      relayerUrl: config.walrus.memwal.relayerUrl,
      namespace: config.walrus.memwal.namespace,
      logger
    })
  };

  if (command === 'doctor') {
    await runDoctor(config, clients, logger);
    return;
  }

  if (command === 'account:address') {
    const address = clients.suiExecution.getAddress();
    logger.info('Derived Sui address', { address });
    return;
  }

  if (command === 'run-daemon') {
    await runDaemon({ config, clients, logger });
    return;
  }

  if (command !== 'run-once') {
    logger.error(`Unknown command: ${command}`);
    process.exitCode = 1;
    return;
  }

  const agent = createAutonomousAgent({
    config,
    clients,
    logger
  });

  const result = await agent.runOnce();
  printRunReport(result.outputText);
}

function printRunReport(outputText?: string): void {
  const report = outputText?.trim();
  if (!report) {
    return;
  }

  const divider = '═'.repeat(72);
  process.stdout.write(`\n${divider}\n  AGENT RUN REPORT\n${divider}\n\n${report}\n\n${divider}\n\n`);
}

async function runDoctor(config: AppConfig, clients: Clients, logger: Logger): Promise<void> {
  logger.info('Running configuration doctor...');
  logger.info(`Agent: ${config.agent.name}`);
  logger.info(`Mission: ${config.agent.mission}`);
  logger.info(`Wallet: ${config.agent.walletAddress}`);
  logger.info(`OpenAI model: ${config.openai.model}`);
  logger.info(`Dry run: ${config.runtime.dryRun}`);
  logger.info(`Autonomy interval ms: ${config.runtime.autonomyIntervalMs}`);
  logger.info(`Agent state path: ${config.agent.statePath}`);
  logger.info(`Action cooldown ms: ${config.agent.actionCooldownMs}`);
  logger.info(`Sui network: ${config.sui.network}`);
  logger.info(`Sui RPC URL: ${config.sui.rpcUrl}`);
  logger.info(`Sui lending enabled: ${config.sui.enabled}`);
  logger.info(`Sui position creation enabled: ${config.sui.enablePositionCreation}`);
  logger.info(`Sui borrow enabled: ${config.sui.enableBorrow}`);
  logger.info(`Suilend enabled: ${config.sui.protocols.suilend.enabled}`);
  logger.info(`NAVI reads enabled: ${config.sui.protocols.navi.enabled}`);
  logger.info(`Scallop reads enabled: ${config.sui.protocols.scallop.enabled}`);
  const writeProtocols = (['suilend', 'navi', 'scallop'] as const)
    .filter((p) => config.sui.protocols[p].write && config.sui.allowedProtocols.includes(p))
    .join(', ');
  logger.info(`Write-enabled protocols: ${writeProtocols || '(none)'}`);
  logger.info(`Allowed protocols: ${config.sui.allowedProtocols.join(', ')}`);
  logger.info(`Rebalance min APR delta (bps): ${config.sui.rebalanceMinAprDeltaBps}`);
  logger.info(`Min health factor: ${config.sui.minHealthFactor}`);
  logger.info(`X posting enabled: ${config.x.enablePosting}`);
  logger.info(`Memory backend: ${config.walrus.memoryBackend}`);
  logger.info(`Walrus publisher: ${config.walrus.publisherUrl}`);
  logger.info(`Walrus aggregator: ${config.walrus.aggregatorUrl}`);
  logger.info(`Walrus Memory (MemWal) enabled: ${config.walrus.memwal.enabled}`);

  if (config.walrus.memoryBackend === 'walrus' && !config.walrus.publisherUrl) {
    logger.warn('AGENT_MEMORY_BACKEND=walrus but WALRUS_PUBLISHER_URL is empty.');
  }

  if (
    config.walrus.memwal.enabled &&
    (!config.walrus.memwal.accountId || !config.walrus.memwal.delegateKey)
  ) {
    logger.warn(
      'MEMWAL_ENABLED=true but MEMWAL_ACCOUNT_ID or MEMWAL_DELEGATE_KEY is empty. Semantic memory will be disabled.'
    );
  }

  if (!config.agent.walletAddress) {
    logger.warn('Set AGENT_WALLET_ADDRESS before expecting meaningful live Sui reads.');
  }

  if (!config.openai.apiKey) {
    logger.warn('Set OPENAI_API_KEY before running the autonomous agent.');
  }

  const keyStatus = describeSuiPrivateKeyConfig(process.env.AGENT_SUI_PRIVATE_KEY ?? '');
  if (!keyStatus.configured) {
    logger.warn('AGENT_SUI_PRIVATE_KEY is empty. On-chain writes will fail.');
  } else if (!keyStatus.valid) {
    logger.warn('AGENT_SUI_PRIVATE_KEY is set but invalid for signing', { hint: keyStatus.hint });
  } else if (config.agent.walletAddress) {
    try {
      const derived = clients.suiExecution.getAddress();
      if (derived !== config.agent.walletAddress) {
        logger.warn('AGENT_WALLET_ADDRESS does not match derived Sui address', {
          configured: config.agent.walletAddress,
          derived
        });
      } else {
        logger.info('Sui wallet address matches derived key', { address: derived });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Could not derive Sui address from key', { error: message });
    }
  }

  if (config.sui.enablePositionCreation || config.sui.enableBorrow) {
    if (!config.sui.rpcUrl) {
      logger.warn('Position writes enabled but SUI_RPC_URL is empty.');
    }

    if (!keyStatus.configured || !keyStatus.valid) {
      logger.warn('Position writes enabled but AGENT_SUI_PRIVATE_KEY is missing or invalid.');
    }

    if (config.sui.allowedAssets.length === 0) {
      logger.warn(
        'Position writes enabled but SUI_ALLOWED_ASSETS is empty. All assets are permitted by default.'
      );
    }
  }

  if (config.sui.enabled && !config.sui.protocols.suilend.enabled) {
    logger.warn(
      'ENABLE_SUI_LENDING=true but ENABLE_SUILEND=false. Suilend reads and writes will be unavailable.'
    );
  }

  const rpcOk = await clients.suiExecution.pingRpc();
  if (rpcOk) {
    logger.info('Sui RPC ping succeeded');
  } else {
    logger.warn('Sui RPC ping failed. Check SUI_RPC_URL and network connectivity.');
  }

  if (!config.runtime.dryRun) {
    logger.warn('DRY_RUN=false. Write actions can execute if their specific enable flags are also true.');
  }

  if (config.x.enablePosting && !config.x.userAccessToken) {
    logger.warn('ENABLE_X_POSTING=true but X_USER_ACCESS_TOKEN is empty.');
  }
}

async function runDaemon({
  config,
  clients,
  logger
}: {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
}): Promise<void> {
  const agent = createAutonomousAgent({ config, clients, logger });
  let running = false;

  async function tick(): Promise<void> {
    if (running) {
      logger.warn('Skipping daemon tick because prior loop is still running');
      return;
    }

    running = true;
    try {
      const result = await agent.runOnce();
      printRunReport(result.outputText);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Autonomous daemon loop failed', { error: message });
    } finally {
      running = false;
    }
  }

  logger.info('Starting autonomous daemon', {
    intervalMs: config.runtime.autonomyIntervalMs
  });

  await tick();
  setInterval(tick, config.runtime.autonomyIntervalMs);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message
    })
  );
  process.exitCode = 1;
});
