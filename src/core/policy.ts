import type { AgentAction, AppConfig } from '../types.js';

export function evaluateActionPolicy(action: AgentAction, config: AppConfig): { allowed: boolean; reason: string } {
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

    if (!config.fluid.enablePositionCreation) {
      return deny('Fluid position creation is disabled');
    }

    if (!config.evm.baseRpcUrl) {
      return deny('BASE_RPC_URL is missing');
    }

    if (!config.evm.privateKey) {
      return deny('AGENT_PRIVATE_KEY is missing');
    }

    if (config.evm.accountMode === 'smart' && !config.evm.smartAccountBundlerUrl) {
      return deny('SMART_ACCOUNT_BUNDLER_URL is missing');
    }

    const fTokenAddress = String(action.details?.fTokenAddress ?? '');
    if (!fTokenAddress) {
      return deny('fTokenAddress is required');
    }

    if (
      config.fluid.allowedFTokens.length > 0 &&
      !config.fluid.allowedFTokens.some((address) => address.toLowerCase() === fTokenAddress.toLowerCase())
    ) {
      return deny('Requested Fluid market is not in FLUID_ALLOWED_FTOKENS');
    }

    const rawAmount = BigInt(String(action.details?.rawAmount ?? '0'));
    if (rawAmount <= 0n) {
      return deny('rawAmount must be greater than zero');
    }

    if (rawAmount > config.fluid.maxSupplyAmountRaw) {
      return deny('Requested Fluid supply amount exceeds FLUID_MAX_SUPPLY_AMOUNT_RAW');
    }

    return allow();
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
