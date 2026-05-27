import { requestJson, withQuery } from '../utils/http.js';
import type { Logger, NetworkName, SwapResponse } from '../types.js';

interface MoltxSwapClientOptions {
  baseUrl: string;
  logger: Logger;
}

interface SwapQuoteParams {
  network: NetworkName;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  slippage: number;
  maxSlippage?: number;
  user: string;
  eoaAddress?: string;
  accountType?: 'eoa';
  aggregators?: string[];
  disabledProtocols?: string[];
}

export class MoltxSwapClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor({ baseUrl, logger }: MoltxSwapClientOptions) {
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  async getQuote(params: SwapQuoteParams): Promise<SwapResponse> {
    const url = withQuery(this.baseUrl, 'swap', {
      network: params.network,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount,
      slippage: params.slippage,
      maxSlippage: params.maxSlippage,
      user: params.user,
      eoaAddress: params.eoaAddress ?? params.user,
      accountType: params.accountType ?? 'eoa',
      'aggregators[]': params.aggregators,
      'disabledProtocols[]': params.disabledProtocols
    });

    const response = await requestJson<Omit<SwapResponse, 'validRoutes' | 'bestRoute'>>(url);
    const validRoutes = (response.aggregators ?? []).filter((route) => !route.error);
    return {
      ...response,
      validRoutes,
      bestRoute: validRoutes[0] ?? null
    };
  }
}
