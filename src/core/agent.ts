import { createExecutor } from './executor.js';
import { evaluateActionPolicy } from './policy.js';
import type { AgentAction, AppConfig, Clients, Logger, StrategyResult } from '../types.js';

interface AgentOptions {
  config: AppConfig;
  clients: Clients;
  strategy: (context: { config: AppConfig; clients: Clients; logger: Logger }) => Promise<StrategyResult>;
  logger: Logger;
}

export function createAgent({ config, clients, strategy, logger }: AgentOptions) {
  const executor = createExecutor({ config, clients, logger });

  return {
    async runOnce() {
      logger.info('Starting agent loop', {
        agent: config.agent.name,
        dryRun: config.runtime.dryRun
      });

      const result = await strategy({ config, clients, logger });
      const actions = [
        ...result.observations.map((observation) => ({
          type: 'OBSERVE',
          summary: observation.summary,
          details: observation.details
        })),
        ...result.actions
      ];

      for (const action of actions) {
        const decision = evaluateActionPolicy(action, config);
        if (!decision.allowed) {
          logger.info('Action blocked by policy', {
            type: action.type,
            reason: decision.reason,
            action: summarizeAction(action)
          });
          continue;
        }

        await executor.execute(action);
      }

      logger.info('Agent loop complete', {
        observations: result.observations.length,
        proposedActions: result.actions.length
      });
    }
  };
}

function summarizeAction(action: AgentAction): Record<string, unknown> {
  if (action.type === 'SWAP_EXECUTE') {
    return {
      aggregator: action.route?.displayName,
      sellAmount: action.details?.sellAmount,
      buyAmount: action.details?.buyAmount,
      priceImpact: action.details?.priceImpact
    };
  }

  if (action.type === 'SOCIAL_POST') {
    return { content: action.content };
  }

  return action.details ?? {};
}
