import { requestJson, withQuery } from '../utils/http.js';
import type { FluidPositionsResponse, Logger } from '../types.js';

interface FluidClientOptions {
  baseUrl: string;
  logger: Logger;
}

export class FluidClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor({ baseUrl, logger }: FluidClientOptions) {
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  async getPositions(address: string): Promise<FluidPositionsResponse> {
    return requestJson<FluidPositionsResponse>(withQuery(this.baseUrl, 'positions', { address }));
  }

  async stats(days = 30): Promise<Record<string, unknown>> {
    return requestJson(withQuery(this.baseUrl, 'stats', { days }));
  }
}
