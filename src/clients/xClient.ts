import { joinUrl, requestJson } from '../utils/http.js';
import type { Logger } from '../types.js';

interface XClientOptions {
  apiBase: string;
  userAccessToken: string;
  logger: Logger;
}

interface CreatePostResponse {
  data?: {
    id?: string;
    text?: string;
  };
}

export interface CreatedXPost {
  id: string;
  text: string;
}

export class XClient {
  private readonly apiBase: string;
  private readonly userAccessToken: string;
  private readonly logger: Logger;

  constructor({ apiBase, userAccessToken, logger }: XClientOptions) {
    this.apiBase = apiBase;
    this.userAccessToken = userAccessToken;
    this.logger = logger;
  }

  async createPost(text: string): Promise<CreatedXPost> {
    if (!this.userAccessToken) {
      throw new Error('X_USER_ACCESS_TOKEN is required to post to X');
    }

    const response = await requestJson<CreatePostResponse>(joinUrl(this.apiBase, '2/tweets'), {
      method: 'POST',
      retries: 0,
      headers: {
        authorization: `Bearer ${this.userAccessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    const id = response.data?.id;
    const returnedText = response.data?.text;
    if (!id || !returnedText) {
      throw new Error('X create post response did not include data.id and data.text');
    }

    this.logger.info('Created X post', { id });
    return { id, text: returnedText };
  }
}
