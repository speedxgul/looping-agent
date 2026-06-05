import {
  beginRun,
  endRun,
  getMemorySummary,
  loadAgentState,
  resolveAgentStatePath,
  saveAgentState
} from './agentMemory.js';
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

  return {
    async runOnce() {
      const state = loadAgentState(config, statePath);
      const runId = beginRun(state);
      const persist = () => saveAgentState(statePath, state);

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
        runId,
        statePath
      });

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
                JSON.stringify(getMemorySummary(state, config, runId), null, 2)
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
        persist();
      }

      logger.info('Autonomous agent loop complete', {
        output: result?.outputText || '(no text output)',
        runId
      });

      return result ?? { response: null, outputText: undefined };
    }
  };
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
    'If a wallet is configured and Fluid lending is enabled, call get_fluid_positions AND get_fluid_markets.',
    'Call get_wallet_balances before any deposit to see idle USDC and treasury hints.',
    'When deciding where to deposit, compare get_fluid_markets totalApr across allowlisted fTokens (higher is better). stakingApr and merkleRewardsApr are extras not in totalApr.',
    'If memory shows pending tweet_deposit, do NOT call create_fluid_position; use post_deposit_update instead (or report not implemented).',
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
