import { createAgent } from './core/agent.js';
import { loadConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { MoltxSocialClient } from './clients/moltxSocialClient.js';
import { MoltxSwapClient } from './clients/moltxSwapClient.js';
import { FluidClient } from './clients/fluidClient.js';
import { LaunchpadClient } from './clients/launchpadClient.js';
import { OpenAIResponsesClient } from './clients/openaiResponsesClient.js';
import { createAutonomousAgent } from './core/autonomousAgent.js';
import { stablecoinTreasuryStrategy } from './strategies/stablecoinTreasuryStrategy.js';
import type { AppConfig, Clients, Logger } from './types.js';

async function main() {
  const command = process.argv[2] || 'run-once';
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const clients = {
    social: new MoltxSocialClient({
      baseUrl: config.moltx.apiBase,
      apiKey: config.moltx.apiKey,
      logger
    }),
    swap: new MoltxSwapClient({
      baseUrl: config.swap.baseUrl,
      logger
    }),
    fluid: new FluidClient({
      baseUrl: config.fluid.baseUrl,
      logger
    }),
    launchpad: new LaunchpadClient({
      baseUrl: config.launchpad.baseUrl,
      logger
    }),
    openai: new OpenAIResponsesClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      logger
    })
  };

  if (command === 'doctor') {
    runDoctor(config, logger);
    return;
  }

  if (command === 'run-daemon') {
    await runDaemon({ config, clients, logger });
    return;
  }

  if (command === 'run-strategy') {
    const agent = createAgent({
      config,
      clients,
      strategy: stablecoinTreasuryStrategy,
      logger
    });

    await agent.runOnce();
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

  await agent.runOnce();
}

function runDoctor(config: AppConfig, logger: Logger): void {
  logger.info('Running configuration doctor...');
  logger.info(`Agent: ${config.agent.name}`);
  logger.info(`Mission: ${config.agent.mission}`);
  logger.info(`Wallet: ${config.agent.walletAddress}`);
  logger.info(`OpenAI model: ${config.openai.model}`);
  logger.info(`Dry run: ${config.runtime.dryRun}`);
  logger.info(`Autonomy interval ms: ${config.runtime.autonomyIntervalMs}`);
  logger.info(`Fluid lending enabled: ${config.fluid.enabled}`);
  logger.info(`Swap quotes enabled: ${config.swap.enableQuotes}`);
  logger.info(`Autonomous swaps enabled: ${config.swap.enableAutonomousSwaps}`);
  logger.info(`MoltX posting enabled: ${config.moltx.postUpdates}`);
  logger.info(`Token launches enabled: ${config.launchpad.enabled}`);

  if (!config.agent.walletAddress || config.agent.walletAddress === '0x0000000000000000000000000000000000000000') {
    logger.warn('Set AGENT_WALLET_ADDRESS before expecting meaningful live DeFi reads.');
  }

  if (!config.openai.apiKey) {
    logger.warn('Set OPENAI_API_KEY before running the autonomous agent.');
  }

  if (config.moltx.postUpdates && !config.moltx.apiKey) {
    logger.warn('POST_TO_MOLTX=true but MOLTX_API_KEY is empty. Posting will fail.');
  }

  if (!config.runtime.dryRun) {
    logger.warn('DRY_RUN=false. Write actions can execute if their specific enable flags are also true.');
  }
}

async function runDaemon({ config, clients, logger }: { config: AppConfig; clients: Clients; logger: Logger }): Promise<void> {
  const agent = createAutonomousAgent({ config, clients, logger });
  let running = false;

  async function tick(): Promise<void> {
    if (running) {
      logger.warn('Skipping daemon tick because prior loop is still running');
      return;
    }

    running = true;
    try {
      await agent.runOnce();
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
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    level: 'error',
    message
  }));
  process.exitCode = 1;
});
