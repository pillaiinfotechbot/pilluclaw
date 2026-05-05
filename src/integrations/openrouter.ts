/**
 * WT-NC-07 — OpenRouter integration SDK stub.
 *
 * Single method: `chat({ model, system, user, max_tokens, temperature })` →
 * `{ content, usage }` via a real OpenRouter chat completions call.
 *
 * API key from `OPENROUTER_API_KEY` env. Network call has a 30s default timeout
 * (callers can override). Throws on non-2xx — the caller decides whether to
 * retry / surface as workflow step failure.
 */
import { logger } from '../logger.js';
import type { Integration, IntegrationMethod } from './registry.js';

export interface OpenRouterChatInput {
  model: string;
  system: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
}

export interface OpenRouterChatOutput {
  content: string;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenRouterIntegration implements Integration {
  constructor(
    private readonly apiKey: string = process.env.OPENROUTER_API_KEY ?? '',
    private readonly baseUrl: string = 'https://openrouter.ai/api/v1',
    /** Override fetch for testing — defaults to globalThis.fetch (Node 20+). */
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  name(): string {
    return 'openrouter';
  }

  methods(): Record<string, IntegrationMethod> {
    return {
      chat: (input) => this.chat(input as unknown as OpenRouterChatInput),
    };
  }

  async chat(input: OpenRouterChatInput): Promise<OpenRouterChatOutput> {
    if (!this.apiKey) {
      throw new Error('OpenRouterIntegration: OPENROUTER_API_KEY not set');
    }
    if (!input.model || !input.system || !input.user) {
      throw new Error(
        'OpenRouterIntegration.chat: model, system, and user are required',
      );
    }

    const timeoutMs = input.timeout_ms ?? 30000;
    const body: Record<string, unknown> = {
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      max_tokens: input.max_tokens ?? 500,
    };
    if (input.temperature !== undefined) {
      body.temperature = input.temperature;
    }

    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `OpenRouterIntegration.chat: HTTP ${res.status} — ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: OpenRouterChatOutput['usage'];
    };

    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content) {
      logger.warn({ json }, 'OpenRouterIntegration.chat: empty completion');
    }
    return {
      content,
      usage: json.usage ?? {},
    };
  }
}
