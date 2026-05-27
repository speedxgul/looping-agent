import { joinUrl, requestJson } from '../utils/http.js';
import type { Logger, OpenAIInputItem, OpenAIResponse, OpenAIToolDefinition } from '../types.js';

interface OpenAIResponsesClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  logger: Logger;
}

interface CreateResponseParams {
  instructions: string;
  input: OpenAIInputItem[];
  tools: OpenAIToolDefinition[];
}

export class OpenAIResponsesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly logger: Logger;

  constructor({ apiKey, baseUrl, model, logger }: OpenAIResponsesClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.logger = logger;
  }

  async create({ instructions, input, tools }: CreateResponseParams): Promise<OpenAIResponse> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for autonomous runs');
    }

    return requestJson<OpenAIResponse>(joinUrl(this.baseUrl, 'responses'), {
      method: 'POST',
      retries: 1,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        instructions,
        input,
        tools,
        store: false
      })
    });
  }
}
