import type { AgentAction, AppConfig, Clients, Logger } from '../types.js';

interface ExecutorOptions {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
}

export function createExecutor({ config, clients, logger }: ExecutorOptions) {
  return {
    async execute(action: AgentAction): Promise<{ status: string; result?: unknown }> {
      if (action.type === 'OBSERVE') {
        logger.info(action.summary, action.details);
        return { status: 'observed' };
      }

      if (action.type === 'SOCIAL_POST') {
        if (config.runtime.dryRun) {
          logger.info('Dry-run social post skipped', { content: action.content });
          return { status: 'dry-run' };
        }

        const result = await clients.social.createPost({ content: action.content });
        logger.info('Posted update to MoltX', { id: extractPostId(result) });
        return { status: 'posted', result };
      }

      if (action.type === 'SWAP_EXECUTE') {
        logger.warn('Swap execution requested, but no signer executor exists in v1', {
          route: action.route?.displayName
        });
        return { status: 'not-implemented' };
      }

      if (action.type === 'FLUID_SUPPLY') {
        logger.warn('Fluid supply execution requires a signer or wallet transaction adapter', action.details);
        return { status: 'not-implemented' };
      }

      if (action.type === 'TOKEN_LAUNCH') {
        logger.warn('Token launches are intentionally left as an explicit future module', action.details);
        return { status: 'not-implemented' };
      }

      logger.warn('Unhandled action', action);
      return { status: 'unhandled' };
    }
  };
}

function extractPostId(result: Record<string, unknown>): unknown {
  const data = result.data;
  if (data && typeof data === 'object' && 'id' in data) {
    return data.id;
  }

  return result.id;
}
