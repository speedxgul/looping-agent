import type { AgentAction, AppConfig } from '../types.js';

export function evaluateActionPolicy(action: AgentAction, config: AppConfig): { allowed: boolean; reason: string } {
  if (action.type === 'SOCIAL_POST') {
    if (!config.moltx.postUpdates) {
      return deny('MoltX posting is disabled');
    }

    if (!config.moltx.apiKey) {
      return deny('MoltX API key is missing');
    }

    return allow();
  }

  if (action.type === 'SWAP_EXECUTE') {
    if (!config.swap.enableAutonomousSwaps) {
      return deny('Autonomous swaps are disabled');
    }

    if (Number(action.route?.data?.priceImpact ?? 0) > config.swap.maxPriceImpactPercent) {
      return deny('Route price impact exceeds configured maximum');
    }

    return allow();
  }

  if (action.type === 'FLUID_SUPPLY') {
    if (!config.fluid.enabled) {
      return deny('Fluid lending is disabled');
    }

    return deny('Fluid supply execution is not implemented in v1');
  }

  if (action.type === 'TOKEN_LAUNCH') {
    if (!config.launchpad.enabled) {
      return deny('Token launches are disabled');
    }

    return deny('Token launch execution is intentionally disabled in v1');
  }

  if (action.type === 'OBSERVE') {
    return allow();
  }

  return deny(`Unknown action type: ${action.type}`);
}

function allow(): { allowed: true; reason: string } {
  return { allowed: true, reason: 'allowed' };
}

function deny(reason: string): { allowed: false; reason: string } {
  return { allowed: false, reason };
}
