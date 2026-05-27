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
  const toolRegistry = createToolRegistry({ config, clients, logger });

  return {
    async runOnce() {
      logger.info('Starting autonomous agent loop', {
        agent: config.agent.name,
        model: config.openai.model,
        dryRun: config.runtime.dryRun
      });

      const input: OpenAIInputItem[] = [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildRunPrompt(config)
            }
          ]
        }
      ];

      const result = await runToolLoop({
        clients,
        config,
        logger,
        toolRegistry,
        input
      });

      logger.info('Autonomous agent loop complete', {
        output: result.outputText || '(no text output)'
      });

      return result;
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

function buildInstructions(config: AppConfig): string {
  return [
    `You are ${config.agent.name}, an autonomous DeFi operations agent.`,
    `Mission: ${config.agent.mission}`,
    'You operate conservatively. Your job is to observe, reason, and act only through the provided tools.',
    'Never claim that you executed a swap, deposit, borrow, token launch, or social post unless the tool result says it executed.',
    'Prefer read-only monitoring and concise summaries. Do not ask for private keys.',
    'Respect local policy gates: dry-run mode, social posting flags, swap execution flags, and token launch flags are final.',
    'If an action is blocked, explain the blocker and the next configuration change needed.',
    'Keep final summaries short and operational: observations, attempted actions, blocked actions, next check.'
  ].join('\n');
}

function buildRunPrompt(config: AppConfig): string {
  return [
    'Run one autonomous DeFi monitoring cycle.',
    `Wallet: ${config.agent.walletAddress || '(not configured)'}`,
    `Dry run: ${config.runtime.dryRun}`,
    `Fluid lending enabled: ${config.fluid.enabled}`,
    `Swap quotes enabled: ${config.swap.enableQuotes}`,
    `Autonomous swaps enabled: ${config.swap.enableAutonomousSwaps}`,
    `MoltX posting enabled: ${config.moltx.postUpdates}`,
    `Token launches enabled: ${config.launchpad.enabled}`,
    'Use tools as needed, then return a concise final summary.'
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
