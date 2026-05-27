import { TOKENS, findTokenByAddress } from '../core/tokenRegistry.js';
import { formatUnits } from '../utils/amounts.js';
import type { AppConfig, Clients, FluidPosition, Logger, StrategyResult, SwapResponse } from '../types.js';

export async function stablecoinTreasuryStrategy({
  config,
  clients,
  logger
}: {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
}): Promise<StrategyResult> {
  const observations = [];
  const actions = [];

  const wallet = config.agent.walletAddress;
  if (!wallet) {
    observations.push({
      summary: 'No wallet configured',
      details: { hint: 'Set AGENT_WALLET_ADDRESS in .env' }
    });
    return { observations, actions };
  }

  let positions = [];
  if (config.fluid.enabled) {
    const response = await clients.fluid.getPositions(wallet);
    positions = response.positions ?? [];
    observations.push(buildFluidObservation(positions));

    const usdcPosition = positions.find(
      (position) => position.underlying?.toLowerCase() === TOKENS.base.USDC.address.toLowerCase()
    );

    if (usdcPosition && BigInt(usdcPosition.userBalance) >= config.fluid.minIdleUsdcRaw) {
      actions.push({
        type: 'FLUID_SUPPLY',
        details: {
          reason: 'Idle USDC balance exceeds configured threshold',
          token: 'USDC',
          walletBalanceRaw: usdcPosition.userBalance,
          walletBalance: formatUnits(usdcPosition.userBalance, usdcPosition.decimals),
          fToken: usdcPosition.fToken
        }
      });
    }
  }

  if (config.swap.enableQuotes && hasQuoteConfig(config)) {
    const quote = await clients.swap.getQuote({
      network: config.swap.quoteNetwork,
      sellToken: config.swap.quoteSellToken,
      buyToken: config.swap.quoteBuyToken,
      sellAmount: config.swap.quoteSellAmount,
      slippage: config.swap.maxSlippagePercent,
      maxSlippage: config.swap.maxSlippagePercent,
      user: wallet
    });

    observations.push(buildSwapObservation(config, quote));

    if (quote.bestRoute) {
      actions.push({
        type: 'SWAP_EXECUTE',
        route: quote.bestRoute,
        details: {
          reason: 'A valid configured swap route is available',
          aggregator: quote.bestRoute.displayName,
          sellAmount: quote.bestRoute.data.sellTokenAmount,
          buyAmount: quote.bestRoute.data.buyTokenAmount,
          priceImpact: quote.bestRoute.data.priceImpact
        }
      });
    }
  }

  const socialContent = buildSocialSummary({ config, positions });
  actions.push({
    type: 'SOCIAL_POST',
    content: socialContent
  });

  logger.debug('Strategy proposed actions', actions);
  return { observations, actions };
}

function buildFluidObservation(positions: FluidPosition[]): { summary: string; details: Record<string, unknown> } {
  const totalPositions = positions.length;
  const summaries = positions.map((position) => ({
    symbol: position.symbol,
    apr: position.totalApr,
    userAssets: formatUnits(position.userAssets ?? '0', position.decimals),
    walletBalance: formatUnits(position.userBalance ?? '0', position.decimals)
  }));

  return {
    summary: 'Fluid positions loaded',
    details: {
      totalPositions,
      positions: summaries
    }
  };
}

function buildSwapObservation(config: AppConfig, quote: SwapResponse): { summary: string; details: Record<string, unknown> } {
  const sellToken = findTokenByAddress(config.swap.quoteNetwork, config.swap.quoteSellToken);
  const buyToken = findTokenByAddress(config.swap.quoteNetwork, config.swap.quoteBuyToken);

  return {
    summary: 'Swap quote loaded',
    details: {
      network: config.swap.quoteNetwork,
      sellToken: sellToken?.symbol ?? config.swap.quoteSellToken,
      buyToken: buyToken?.symbol ?? config.swap.quoteBuyToken,
      totalAggregators: quote.data?.totalAggregators ?? quote.aggregators?.length ?? 0,
      bestRoute: quote.bestRoute
        ? {
            aggregator: quote.bestRoute.displayName,
            buyTokenAmount: quote.bestRoute.data.buyTokenAmount,
            priceImpact: quote.bestRoute.data.priceImpact
          }
        : null
    }
  };
}

function buildSocialSummary({ config, positions }: { config: AppConfig; positions: FluidPosition[] }): string {
  const usdcPosition = positions.find(
    (position) => position.underlying?.toLowerCase() === TOKENS.base.USDC.address.toLowerCase()
  );

  if (!usdcPosition) {
    return `${config.agent.name}: v1 treasury check complete. No Fluid USDC position detected for the configured wallet. #defi #agents`;
  }

  return [
    `${config.agent.name}: v1 treasury check complete.`,
    `Fluid ${usdcPosition.symbol} APR: ${usdcPosition.totalApr}%.`,
    `Supplied: ${formatUnits(usdcPosition.userAssets, usdcPosition.decimals)} USDC.`,
    `Idle wallet balance: ${formatUnits(usdcPosition.userBalance, usdcPosition.decimals)} USDC.`,
    '#defi #agents'
  ].join(' ');
}

function hasQuoteConfig(config: AppConfig): boolean {
  return Boolean(
    config.swap.quoteNetwork &&
      config.swap.quoteSellToken &&
      config.swap.quoteBuyToken &&
      config.swap.quoteSellAmount &&
      config.swap.quoteSellAmount !== '0'
  );
}
