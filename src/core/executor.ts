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

      if (action.type === 'SWAP_EXECUTE') {
        logger.warn('Swap execution requested, but no signer executor exists in v1', { // will be implemented in this commit, need a signer
          route: action.route?.displayName
        });
        return { status: 'not-implemented' };
      }

      if (action.type === 'FLUID_SUPPLY') {
        logger.warn('Fluid supply execution requires a signer or wallet transaction adapter', action.details);
        return { status: 'not-implemented' };
      }

      logger.warn('Unhandled action', action);
      return { status: 'unhandled' };
    }
  };
}
