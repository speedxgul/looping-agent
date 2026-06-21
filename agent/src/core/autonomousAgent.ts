import type {
  AppConfig,
  Clients,
  Logger,
  OpenAIFunctionCallItem,
  OpenAIInputItem,
  OpenAIOutputItem,
  OpenAIResponse
} from '../types.js';
import {
  type AgentStateV1,
  beginRun,
  endRun,
  getMemorySummary,
  recordArtifact,
  resolveAgentStatePath
} from './agentMemory.js';
import { runHealthGuard } from './healthGuard.js';
import { createMemoryStore, type SaveOptions } from './memoryStore.js';
import { createToolRegistry } from './toolRegistry.js';

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

      const healthGuard = await runHealthGuard({ state, runId, clients, config, logger, persist });

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
        statePath,
        healthGuard
      });

      const recalled = await recallLongTermMemory({ clients, config });
      const input: OpenAIInputItem[] = [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                buildRunPrompt(config, healthGuard),
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
        runId,
        reportChars: result?.outputText?.trim().length ?? 0
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
  const query = `Past Suilend and Sui treasury decisions, supplies, borrows, market APRs, health factor events, and blockers for wallet ${wallet}`;
  const memories = await clients.walrusMemory.recall(query, 5);
  if (memories.length === 0) {
    return null;
  }

  return memories
    .map((memory, index) => `${index + 1}. (distance ${memory.distance.toFixed(3)}) ${memory.text}`)
    .join('\n');
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
  const recentActions = summary.recentActions.length
    ? summary.recentActions
        .map(
          (action) =>
            `- ${action.status} ${action.action} ${action.rawAmount} ${action.asset} on ${action.protocol}` +
            `${action.digest ? ` (digest ${action.digest})` : ''}${action.dryRun ? ' [dry-run]' : ''}`
        )
        .join('\n')
    : '- none';
  const pending = summary.pending.length
    ? summary.pending.map((task) => `- ${task.type}${task.actionId ? ` (${task.actionId})` : ''}`).join('\n')
    : '- none';

  return [
    `# ${config.agent.name} — Run Report`,
    '',
    `- Run id: ${runId}`,
    `- Wallet: ${state.walletAddress}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Dry run: ${config.runtime.dryRun}`,
    `- Top market: ${summary.snapshots.lastTopMarketAsset ?? 'n/a'}`,
    `- Health factor: ${summary.snapshots.lastHealthFactor ?? 'n/a'}`,
    '',
    '## Outcome',
    '',
    outputText,
    '',
    '## Recent position actions',
    '',
    recentActions,
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
    outputText:
      finalResponse?.output_text ?? extractOutputText(finalResponse) ?? 'Stopped after max tool rounds.'
  };
}

function treasuryModeEnabled(config: AppConfig): boolean {
  return !config.runtime.dryRun && config.sui.enabled && config.sui.enablePositionCreation;
}

function buildInstructions(config: AppConfig): string {
  const lines = [
    `You are ${config.agent.name}, an autonomous DeFi operations agent on Sui.`,
    `Mission: ${config.agent.mission}`,
    'You operate conservatively. Your job is to observe, reason, and act only through the provided tools.',
    'Never claim that you executed a supply, borrow, withdraw, or repay unless the tool result says it executed.',
    'Respect local policy gates: dry-run mode and position-creation flags are final.',
    'Always start each cycle by calling inspect_runtime_policy.',
    'Call get_agent_memory early to see prior position actions, pending tasks, health alerts, and action cooldown status.',
    'When useful, call recall_memory to retrieve durable cross-session context (past decisions, market notes, blockers) from Walrus Memory, and remember_insight to store a concise, durable insight worth recalling next run.',
    'A health guard may auto-repay critical borrows (on any protocol) before you run; do not fight or duplicate that action.',
    'If a wallet is configured and Sui lending is enabled, call get_lending_rates_comparison to compare Suilend vs NAVI vs Scallop supply/borrow APRs across allowlisted assets.',
    'Call get_lending_positions per protocol you hold positions on to read deposits, borrows, and health factor.',
    'Call get_strategy_ledger to inspect subagent proposals, accepted plans, active risk locks, and loop positions. If there is an accepted strategy plan, use claim_and_execute_strategy_plan rather than manual lending_borrow/lending_supply so execution is idempotent with subagents.',
    'Call get_sui_balances before any supply to see idle USDC and treasury hints.',
    "Act as an own-impact-aware yield router: call get_optimal_allocation, which splits idle USDC across protocols by equalizing marginal net supply APR (water-filling) rather than dumping everything into the single highest spot rate. Supply EACH returned leg with lending_supply using that leg's protocol + rawAmount.",
    'When loop strategy is enabled and get_optimal_allocation returns no allocations because main-agent supply is paused, do not call lending_supply manually; let subagents evaluate existing collateral through the strategy ledger.',
    'get_optimal_allocation is preferred over get_best_supply_target (the latter is a simpler highest-APR fallback). Only move already-supplied funds when the improvement clears SUI_REBALANCE_MIN_APR_DELTA_BPS and the amortized gain beats execution cost.',
    'Use lending_supply/lending_withdraw/lending_borrow/lending_repay with an explicit protocol (suilend|navi|scallop). Writes are gated by SUI_ALLOWED_PROTOCOLS and per-protocol enable flags.',
    'A pending tweet_action only matters when X posting is enabled (ENABLE_X_POSTING=true with a token): in that case handle it with post_action_update before new supplies. If X posting is disabled or unconfigured, IGNORE any pending tweet_action and proceed with supplies normally — the tweet can never post and must not block treasury actions.',
    'Position actions are recorded automatically in agent memory; do not duplicate supplies within the cooldown window.',
    'Borrow only when simulated health factor stays above SUI_MIN_HEALTH_FACTOR.',
    'If an action is blocked, explain the blocker and the next configuration change needed.',
    'Keep final summaries short and operational: observations, attempted actions, blocked actions, next check.'
  ];

  if (treasuryModeEnabled(config)) {
    lines.push(
      'Treasury mode is ON: when USDC balance meets MIN_IDLE_USDC_RAW and memory allows, call get_optimal_allocation and supply each allocation leg via lending_supply (protocol + rawAmount per leg). The solver already caps each leg by SUI_MAX_SUPPLY_AMOUNT_RAW and per-pool deposit limits.',
      'After a confirmed supply, memory queues a tweet_action only when X posting is enabled; when it does, attempt post_action_update. When posting is disabled, no tweet is queued and supplies proceed without that step.'
    );
  } else {
    lines.push('Prefer read-only monitoring when dry-run or position creation is disabled.');
  }

  if (config.treasury.enabled) {
    lines.push(
      'NON-CUSTODIAL TREASURY MODE is ON: the funds live in the on-chain Treasury, NOT your wallet — your wallet only pays gas. Use get_treasury_status (deployable budget + whether you are still authorized), get_treasury_positions (positions custodied in the vault), and treasury_supply (the attested enclave decides + signs the allocation; you only submit it). Prefer these over the wallet tools (get_sui_balances / get_optimal_allocation / lending_supply), which move your own wallet funds.'
    );
  }

  return lines.join('\n');
}

function buildRunPrompt(config: AppConfig, healthGuard: { executed: boolean; reason?: string }): string {
  const cycleType = treasuryModeEnabled(config) ? 'treasury' : 'monitoring';

  const toolOrder = treasuryModeEnabled(config)
    ? 'inspect_runtime_policy → get_agent_memory → get_strategy_ledger → get_lending_rates_comparison → get_lending_positions → get_sui_balances → get_optimal_allocation → (claim_and_execute_strategy_plan if accepted plan exists OR lending_supply per allocation leg|withdraw|borrow|repay OR post_action_update if pending)'
    : 'inspect_runtime_policy → get_agent_memory → get_strategy_ledger → get_lending_rates_comparison → get_lending_positions → get_optimal_allocation';

  const healthGuardNote = healthGuard.executed
    ? 'Health guard auto-repay executed before this cycle.'
    : healthGuard.reason
      ? `Health guard: ${healthGuard.reason}.`
      : 'Health guard: no action taken.';

  return [
    `Run one autonomous Sui ${cycleType} cycle.`,
    `Wallet: ${config.agent.walletAddress || '(not configured)'}`,
    `Dry run: ${config.runtime.dryRun}`,
    `Sui lending enabled: ${config.sui.enabled}`,
    `Sui position creation: ${config.sui.enablePositionCreation}`,
    `Sui borrow enabled: ${config.sui.enableBorrow}`,
    `Network: ${config.sui.network}`,
    healthGuardNote,
    `Suggested tool order: ${toolOrder}.`,
    'Report memory pending tasks, the best supply target across protocols, rate comparison rows, wallet USDC, health factor, and any position action or tweet attempts.'
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
