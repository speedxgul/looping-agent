import { joinUrl, requestJson } from '../utils/http.js';
import type { Logger } from '../types.js';

interface LaunchpadClientOptions {
  baseUrl: string;
  logger: Logger;
}

export class LaunchpadClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor({ baseUrl, logger }: LaunchpadClientOptions) {
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  async createDeposit(): Promise<Record<string, unknown>> {
    return requestJson(joinUrl(this.baseUrl, 'api/deposit'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
  }

  async getDeposit(address: string): Promise<Record<string, unknown>> {
    return requestJson(joinUrl(this.baseUrl, `api/deposit/${address}`));
  }

  async deployToken(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson(joinUrl(this.baseUrl, 'api/deploy'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async initialBuy(tokenAddress: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson(joinUrl(this.baseUrl, `api/deploy/${tokenAddress}/buy`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
}
