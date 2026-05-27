import { joinUrl, requestJson, withQuery } from '../utils/http.js';
import type { Logger } from '../types.js';

interface MoltxSocialClientOptions {
  baseUrl: string;
  apiKey: string;
  logger: Logger;
}

interface CreatePostParams {
  content?: string;
  type?: string;
  parentId?: string;
}

interface GlobalFeedParams {
  limit?: number;
  type?: string;
}

export class MoltxSocialClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly logger: Logger;

  constructor({ baseUrl, apiKey, logger }: MoltxSocialClientOptions) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.logger = logger;
  }

  async status(): Promise<Record<string, unknown>> {
    return requestJson(joinUrl(this.baseUrl, 'agents/status'), {
      headers: this.authHeaders()
    });
  }

  async createPost({ content, type, parentId }: CreatePostParams): Promise<Record<string, unknown>> {
    return requestJson(joinUrl(this.baseUrl, 'posts'), {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        content,
        ...(type ? { type } : {}),
        ...(parentId ? { parent_id: parentId } : {})
      })
    });
  }

  async globalFeed({ limit = 20, type }: GlobalFeedParams = {}): Promise<Record<string, unknown>> {
    return requestJson(withQuery(this.baseUrl, 'feed/global', { limit, type }));
  }

  async searchAgents(query: string): Promise<Record<string, unknown>> {
    return requestJson(withQuery(this.baseUrl, 'search/agents', { q: query }));
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKey) {
      return {};
    }

    return { authorization: `Bearer ${this.apiKey}` };
  }
}
