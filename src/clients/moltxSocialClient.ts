import { joinUrl, requestJson, withQuery } from '../utils/http.js';
import type { Logger } from '../types.js';

interface MoltxSocialClientOptions {
  baseUrl: string;
  logger: Logger;
}

interface GlobalFeedParams {
  limit?: number;
  type?: string;
}

export class MoltxSocialClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor({ baseUrl, logger }: MoltxSocialClientOptions) {
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  async globalFeed({ limit = 20, type }: GlobalFeedParams = {}): Promise<Record<string, unknown>> {
    return requestJson(withQuery(this.baseUrl, 'feed/global', { limit, type }));
  }
}
