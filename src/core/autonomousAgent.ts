import {
  beginRun,
  endRun,
  getMemorySummary,
  recordArtifact,
  resolveAgentStatePath,
  type AgentStateV1
} from './agentMemory.js';
import { createMemoryStore, type SaveOptions } from './memoryStore.js';
import { createToolRegistry } from './toolRegistry.js';
import type {
  AppConfig,
  Clients,
  Logger,
  OpenAIFunctionCallItem,
  OpenAIInputItem,
  OpenAIOutputItem,
  OpenAIResponse
} from '../types.js';

interface AutonomousAgentOptions {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
}

export function createAutonomousAgent({ config, clients, logger }: AutonomousAgentOptions) {
  const statePath = resolveAgentStatePath(config);
  const store = createMemoryStore({ config, blobClient: clients.walrusBlob, logger });

  return {
    async runOnce() {
      const state = await store.load();
      const runId = beginRun(state);
      const persist = (opts?: SaveOptions) => store.save(state, opts);

      const toolRegistry = createToolRegistry({
        config,
        clients,
        logger,
        memory: { state, runId, statePath, persist }
      });

      logger.info('Starting autonomous agent loop', {
        agent: config.agent.name,
        model: config.openai.model,
        dryRun: config.runtime.dryRun,
        memoryBackend: config.walrus.memoryBackend,
        walrusMemory: clients.walrusMemory.enabled,
        runId,
        statePath
      });

      const recalled = await recallLongTermMemory({ clients, config });
      const input: OpenAIInputItem[] = [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                buildRunPrompt(config),
                '---',
                'Agent memory (from prior runs):',
                JSON.stringify(getMemorySummary(state, config, runId), null, 2),
                ...(recalled
                  ? ['---', 'Relevant long-term memories (Walrus Memory / MemWal):', recalled]
                  : [])
              ].join('\n')
            }
          ]
        }
      ];

      let result: Awaited<ReturnType<typeof runToolLoop>> | undefined;
      try {
        result = await runToolLoop({
          clients,
          config,
          logger,
          toolRegistry,
          input
        });
      } finally {
        endRun(state, runId, result?.outputText);
        await finalizeRun({ state, runId, outputText: result?.outputText, clients, config, logger });
        await persist({ durable: true });
      }

      logger.info('Autonomous agent loop complete', {
        output: result?.outputText || '(no text output)',
        runId
      });

      return result ?? { response: null, outputText: undefined };
    }
  };
}

/** Pull relevant cross-session memories from MemWal to seed the run prompt. */
async function recallLongTermMemory({
  clients,
  config
}: {
  clients: Clients;
  config: AppConfig;
}): Promise<string | null> {
  if (!clients.walrusMemory.enabled) {
    return null;
  }

  const wallet = config.agent.walletAddress || 'the configured agent';
  const query = `Past DeFi treasury decisions, deposits, market APRs, and blockers for wallet ${wallet}`;
  const memories = await clients.walrusMemory.recall(query, 5);
  if (memories.length === 0) {
    return null;
  }

  return memories.map((memory, index) => `${index + 1}. (distance ${memory.distance.toFixed(3)}) ${memory.text}`).join('\n');
}

/**
 * After a run: archive a verifiable report on Walrus and persist a reflection to
 * MemWal so future runs recall what happened. Best-effort — never throws.
 */
async function finalizeRun({
  state,
  runId,
  outputText,
  clients,
  config,
  logger
}: {
  state: AgentStateV1;
  runId: string;
  outputText: string | undefined;
  clients: Clients;
  config: AppConfig;
  logger: Logger;
}): Promise<void> {
  const summary = outputText?.trim();
  if (!summary) {
    return;
  }

  if (config.walrus.memoryBackend === 'walrus') {
    try {
      const report = buildRunReport({ state, runId, config, outputText: summary });
      const stored = await clients.walrusBlob.storeString(report);
      recordArtifact(state, {
        runId,
        kind: 'run_report',
        blobId: stored.blobId,
        url: stored.url,
        description: 'Autonomous run report'
      });
      logger.info('Stored run report on Walrus', { blobId: stored.blobId, url: stored.url });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to store run report on Walrus', { error: message });
    }
  }

  if (clients.walrusMemory.enabled) {
    const factCount = await clients.walrusMemory.analyze(summary);
    if (factCount === 0) {
      await clients.walrusMemory.remember(`Run ${runId} summary: ${summary}`);
    } else {
      logger.info('Stored run insights in Walrus Memory', { factCount, runId });
    }
  }
}

function buildRunReport({
  state,
  runId,
  config,
  outputText
}: {
  state: AgentStateV1;
  runId: string;
  config: AppConfig;
  outputText: string;
}): string {
  const summary = getMemorySummary(state, config, runId);
  const deposits = summary.recentDeposits.length
    ? summary.recentDeposits
        .map(
          (deposit) =>
            `- ${deposit.status} ${deposit.rawAmount} into ${deposit.fToken}` +
            `${deposit.txHash ? ` (tx ${deposit.txHash})` : ''}${deposit.dryRun ? ' [dry-run]' : ''}`
        )
        .join('\n')
    : '- none';
  const pending = summary.pending.length
    ? summary.pending.map((task) => `- ${task.type} (${task.depositId})`).join('\n')
    : '- none';

  return [
    `# ${config.agent.name} — Run Report`,
    '',
    `- Run id: ${runId}`,
    `- Wallet: ${state.walletAddress}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Dry run: ${config.runtime.dryRun}`,
    `- Top market: ${summary.snapshots.lastTopMarketSymbol ?? 'n/a'}`,
    '',
    '## Outcome',
    '',
    outputText,
    '',
    '## Recent deposits',
    '',
    deposits,
    '',
    '## Pending tasks',
    '',
    pending,
    ''
  ].join('\n');
}

interface ToolLoopOptions {
  clients: Clients;
  config: AppConfig;
  logger: Logger;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  input: OpenAIInputItem[];
}

async function runToolLoop({ clients, config, logger, toolRegistry, input }: ToolLoopOptions) {
  const tools = toolRegistry.definitions();
  let conversation = input;
  let finalResponse: OpenAIResponse | null = null;

  for (let round = 0; round < config.openai.maxToolRounds; round += 1) {
    const response = await clients.openai.create({
      instructions: buildInstructions(config),
      input: conversation,
      tools
    });

    finalResponse = response;
    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0) {
      return {
        response,
        outputText: response.output_text ?? extractOutputText(response)
      };
    }

    conversation = [
      ...conversation,
      ...(response.output ?? []),
      ...(await Promise.all(
        toolCalls.map(async (toolCall) => {
          const output = await toolRegistry.execute(toolCall);
          return {
            type: 'function_call_output',
            call_id: toolCall.call_id,
            output: JSON.stringify(output)
          } satisfies OpenAIInputItem;
        })
      ))
    ];
  }

  logger.warn('Autonomous loop stopped after max tool rounds', {
    maxToolRounds: config.openai.maxToolRounds
  });

  return {
    response: finalResponse,
    outputText: finalResponse?.output_text ?? extractOutputText(finalResponse) ?? 'Stopped after max tool rounds.'
  };
}

function treasuryModeEnabled(config: AppConfig): boolean {
  return !config.runtime.dryRun && config.fluid.enabled && config.fluid.enablePositionCreation;
}

function buildInstructions(config: AppConfig): string {
  const lines = [
    `You are ${config.agent.name}, an autonomous DeFi operations agent.`,
    `Mission: ${config.agent.mission}`,
    'You operate conservatively. Your job is to observe, reason, and act only through the provided tools.',
    'Never claim that you executed a swap, deposit, or borrow unless the tool result says it executed.',
    'Respect local policy gates: dry-run mode and swap execution flags are final.',
    'Always start each cycle by calling inspect_runtime_policy.',
    'Call get_agent_memory early to see prior deposits, pending tasks, and deposit cooldown status.',
    'When useful, call recall_memory to retrieve durable cross-session context (past decisions, market notes, blockers) from Walrus Memory, and remember_insight to store a concise, durable insight worth recalling next run.',
    'If a wallet is configured and Fluid lending is enabled, call get_fluid_positions AND get_fluid_markets.',
    'Call get_wallet_balances before any deposit to see idle USDC and treasury hints.',
    'When deciding where to deposit, compare get_fluid_markets totalApr across allowlisted fTokens (higher is better). stakingApr and merkleRewardsApr are extras not in totalApr.',
    'If memory shows pending tweet_deposit, do NOT call create_fluid_position; use post_deposit_update instead. If X posting is blocked, report the config blocker.',
    'Deposits are recorded automatically in agent memory; do not duplicate deposits within the cooldown window.',
    'If an action is blocked, explain the blocker and the next configuration change needed.',
    'Keep final summaries short and operational: observations, attempted actions, blocked actions, next check.'
  ];

  if (treasuryModeEnabled(config)) {
    lines.push(
      'Treasury mode is ON: when USDC balance meets MIN_IDLE_USDC_RAW and memory allows, call create_fluid_position into the highest-APR allowlisted market (usually fUSDC via market usdc) using depositableRaw from get_wallet_balances, capped by FLUID_MAX_SUPPLY_AMOUNT_RAW.',
      'After a confirmed deposit, memory will queue tweet_deposit; attempt post_deposit_update when appropriate.'
    );
  } else {
    lines.push('Prefer read-only monitoring when dry-run or position creation is disabled.');
  }

  return lines.join('\n');
}

function buildRunPrompt(config: AppConfig): string {
  const cycleType = treasuryModeEnabled(config) ? 'treasury' : 'monitoring';

  const toolOrder = treasuryModeEnabled(config)
    ? 'inspect_runtime_policy → get_agent_memory → get_fluid_positions → get_fluid_markets → get_wallet_balances → (create_fluid_position OR post_deposit_update if pending)'
    : 'inspect_runtime_policy → get_agent_memory → get_fluid_positions → get_fluid_markets';

  return [
    `Run one autonomous DeFi ${cycleType} cycle.`,
    `Wallet: ${config.agent.walletAddress || '(not configured)'}`,
    `Dry run: ${config.runtime.dryRun}`,
    `Fluid lending enabled: ${config.fluid.enabled}`,
    `Fluid position creation: ${config.fluid.enablePositionCreation}`,
    `Swap quotes enabled: ${config.swap.enableQuotes}`,
    `Autonomous swaps enabled: ${config.swap.enableAutonomousSwaps}`,
    `Suggested tool order: ${toolOrder}.`,
    'Report memory pending tasks, ranked markets by totalApr, wallet USDC, and any deposit or tweet attempts.'
  ].join('\n');
}

function extractToolCalls(response: OpenAIResponse): OpenAIFunctionCallItem[] {
  return (response.output ?? []).filter(isFunctionCallItem);
}

function extractOutputText(response: OpenAIResponse | null): string | undefined {
  const message = (response?.output ?? []).find((item) => item.type === 'message');
  const content = 'content' in (message ?? {}) && Array.isArray(message?.content) ? message.content : [];
  const textItems = content.filter((item) => item.type === 'output_text');
  return textItems.map((item) => item.text ?? '').join('\n');
}

function isFunctionCallItem(item: OpenAIOutputItem): item is OpenAIFunctionCallItem {
  return item.type === 'function_call' && typeof item.name === 'string' && typeof item.call_id === 'string';
}
