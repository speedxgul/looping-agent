import { loadConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { MoltxSocialClient } from './clients/moltxSocialClient.js';
import { MoltxSwapClient } from './clients/moltxSwapClient.js';
import { FluidClient } from './clients/fluidClient.js';
import { FluidExecutionClient } from './clients/fluidExecutionClient.js';
import { OpenAIResponsesClient } from './clients/openaiResponsesClient.js';
import { createAutonomousAgent } from './core/autonomousAgent.js';
import type { AppConfig, Clients, Logger } from './types.js';

async function main() {
  const command = process.argv[2] || 'run-once';
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const clients = {
    social: new MoltxSocialClient({
      baseUrl: config.moltx.apiBase,
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
    fluidExecution: new FluidExecutionClient({
      accountMode: config.evm.accountMode,
      rpcUrl: config.evm.baseRpcUrl,
      privateKey: config.evm.privateKey,
      walletAddress: config.agent.walletAddress,
      bundlerUrl: config.evm.smartAccountBundlerUrl,
      usePaymaster: config.evm.smartAccountUsePaymaster,
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

  if (command === 'account:address') {
    const addressInfo = await clients.fluidExecution.getExecutionAddress();
    logger.info('Derived execution account', addressInfo);
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
  if (result.outputText) {
    console.log('\n' + result.outputText + '\n');
  }
}

function runDoctor(config: AppConfig, logger: Logger): void {
  logger.info('Running configuration doctor...');
  logger.info(`Agent: ${config.agent.name}`);
  logger.info(`Mission: ${config.agent.mission}`);
  logger.info(`Wallet: ${config.agent.walletAddress}`);
  logger.info(`Account mode: ${config.evm.accountMode}`);
  logger.info(`OpenAI model: ${config.openai.model}`);
  logger.info(`Dry run: ${config.runtime.dryRun}`);
  logger.info(`Autonomy interval ms: ${config.runtime.autonomyIntervalMs}`);
  logger.info(`Fluid lending enabled: ${config.fluid.enabled}`);
  logger.info(`Fluid position creation enabled: ${config.fluid.enablePositionCreation}`);
  logger.info(`Swap quotes enabled: ${config.swap.enableQuotes}`);
  logger.info(`Autonomous swaps enabled: ${config.swap.enableAutonomousSwaps}`);

  if (!config.agent.walletAddress || config.agent.walletAddress === '0x0000000000000000000000000000000000000000') {
    logger.warn('Set AGENT_WALLET_ADDRESS before expecting meaningful live DeFi reads.');
  }

  if (!config.openai.apiKey) {
    logger.warn('Set OPENAI_API_KEY before running the autonomous agent.');
  }

  if (config.fluid.enablePositionCreation) {
    if (!config.evm.baseRpcUrl) {
      logger.warn('ENABLE_FLUID_POSITION_CREATION=true but BASE_RPC_URL is empty.');
    }

    if (!config.evm.privateKey) {
      logger.warn('ENABLE_FLUID_POSITION_CREATION=true but AGENT_PRIVATE_KEY is empty.');
    }

    if (config.evm.accountMode === 'smart' && !config.evm.smartAccountBundlerUrl) {
      logger.warn('ACCOUNT_MODE=smart but SMART_ACCOUNT_BUNDLER_URL is empty.');
    }

    if (config.fluid.allowedFTokens.length === 0) {
      logger.warn('ENABLE_FLUID_POSITION_CREATION=true but FLUID_ALLOWED_FTOKENS is empty. No Fluid deposits will be permitted.');
    }
  }

  if (config.evm.accountMode === 'smart') {
    logger.info('Smart account type: coinbase');
    if (!config.evm.smartAccountBundlerUrl) {
      logger.warn('ACCOUNT_MODE=smart but SMART_ACCOUNT_BUNDLER_URL is empty. Smart account writes will fail.');
    }
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
      const result = await agent.runOnce();
      if (result.outputText) {
        console.log('\n' + result.outputText + '\n');
      }
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
