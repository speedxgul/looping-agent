// Anthropic-backed drop-in for OpenAIResponsesClient. The agent loop speaks the OpenAI
// "Responses" shape (instructions + input items + tools → output items); Anthropic has no
// Responses API, so this adapter translates to/from the Messages API:
//   instructions          -> system
//   input items           -> messages (merging consecutive same-role items)
//   function_call         -> assistant tool_use block
//   function_call_output  -> user tool_result block
//   tools (OpenAI)        -> Anthropic tools {name, description, input_schema}
// and maps the reply's content blocks back to OpenAI output items (message / function_call)
// so the existing tool loop (autonomousAgent.runToolLoop) works unchanged.
import type { Logger, OpenAIInputItem, OpenAIResponse, OpenAIToolDefinition } from '../../types.js';
import { joinUrl, requestJson } from '../../utils/http.js';

interface AnthropicClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  logger: Logger;
}

interface CreateResponseParams {
  instructions: string;
  input: OpenAIInputItem[];
  tools: OpenAIToolDefinition[];
}

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}
interface AnthropicReply {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''
      )
      .join('');
  }
  return '';
}

function safeParse(s: unknown): unknown {
  if (typeof s !== 'string' || s.length === 0) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Map the OpenAI-Responses input items to Anthropic messages (merging consecutive same-role). */
function toAnthropicMessages(input: OpenAIInputItem[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', block: AnthropicBlock) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const item of input) {
    if (item.type === 'function_call') {
      push('assistant', {
        type: 'tool_use',
        id: String(item.call_id),
        name: String(item.name),
        input: safeParse(item.arguments)
      });
    } else if (item.type === 'function_call_output') {
      push('user', {
        type: 'tool_result',
        tool_use_id: String(item.call_id),
        content: String(item.output ?? '')
      });
    } else if (item.type === 'message' || item.role === 'assistant') {
      const text = textOf(item.content);
      if (text) push('assistant', { type: 'text', text });
    } else {
      push('user', { type: 'text', text: textOf(item.content) });
    }
  }
  return out;
}

/** Map an Anthropic reply back to the OpenAI-Responses output shape the loop expects. */
function toOpenAIResponse(reply: AnthropicReply): OpenAIResponse {
  const output: NonNullable<OpenAIResponse['output']> = [];
  let text = '';
  for (const block of reply.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      output.push({ type: 'message', content: [{ type: 'output_text', text: block.text }] });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        name: String(block.name),
        call_id: String(block.id),
        arguments: JSON.stringify(block.input ?? {})
      });
    }
  }
  return { output, output_text: text || undefined };
}

export class AnthropicResponsesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly logger: Logger;

  constructor({ apiKey, baseUrl, model, maxTokens, logger }: AnthropicClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.maxTokens = maxTokens ?? 4096;
    this.logger = logger;
  }

  async create({ instructions, input, tools }: CreateResponseParams): Promise<OpenAIResponse> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is required for autonomous runs');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: instructions,
      messages: toAnthropicMessages(input)
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }

    const reply = await requestJson<AnthropicReply>(joinUrl(this.baseUrl, 'messages'), {
      method: 'POST',
      retries: 1,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return toOpenAIResponse(reply);
  }
}
