/**
 * WT-NC-08 — Claude subscription integration SDK.
 *
 * Routes Claude calls through the local credential proxy so PilluBot's
 * Pro subscription handles billing ($0 marginal cost). The proxy is started
 * by `src/credential-proxy.ts` and handles api-key OR oauth modes; this
 * integration just sends the chat-completion-style request to it and the
 * proxy injects the real credential.
 *
 * Methods:
 *   - query({ system, user, max_tokens, model? }) → { content, usage? }
 *
 * NOTE on OAuth handshake: the actual Claude Pro session token is managed
 * by the credential proxy (`credential-proxy.ts` reads
 * CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN from the env file). This
 * integration does NOT do its own handshake — it points at the local proxy
 * URL and lets the proxy do the auth injection. PilluBot deployment owns
 * the session-token rotation; that is intentionally OUT OF SCOPE for this
 * SDK and is tracked under a separate WT.
 */
import { logger } from '../logger.js';
import type { Integration, IntegrationMethod } from './registry.js';

export interface ClaudeQueryInput {
  system: string;
  user: string;
  max_tokens?: number;
  model?: string;
  temperature?: number;
  timeout_ms?: number;
}

export interface ClaudeQueryOutput {
  content: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  model: string;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export class ClaudeSubscriptionIntegration implements Integration {
  constructor(
    private readonly proxyUrl: string = process.env.CLAUDE_PROXY_URL ??
      `http://127.0.0.1:${process.env.CREDENTIAL_PROXY_PORT ?? '8765'}`,
    /**
     * Placeholder bearer token. The credential proxy replaces it with the
     * real OAuth token before the upstream call. Setting this to anything
     * non-empty triggers OAuth handling in the proxy when ANTHROPIC_API_KEY
     * isn't set; in api-key mode the proxy ignores it.
     */
    private readonly placeholderToken: string = process.env
      .CLAUDE_PRO_SESSION_TOKEN ?? 'claude-cli-placeholder',
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  name(): string {
    return 'claude_subscription';
  }

  methods(): Record<string, IntegrationMethod> {
    return {
      query: (input) => this.query(input as unknown as ClaudeQueryInput),
    };
  }

  async query(input: ClaudeQueryInput): Promise<ClaudeQueryOutput> {
    if (!input?.system || !input?.user) {
      throw new Error(
        'ClaudeSubscriptionIntegration.query: system and user are required',
      );
    }

    const model = input.model ?? DEFAULT_MODEL;
    const timeoutMs = input.timeout_ms ?? 30000;
    const body: Record<string, unknown> = {
      model,
      max_tokens: input.max_tokens ?? 1024,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    };
    if (input.temperature !== undefined) {
      body.temperature = input.temperature;
    }

    const res = await this.fetchFn(`${this.proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${this.placeholderToken}`,
        'x-api-key': this.placeholderToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ClaudeSubscriptionIntegration.query: HTTP ${res.status} — ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: ClaudeQueryOutput['usage'];
      model?: string;
    };

    const content = (json.content ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('');

    if (!content) {
      logger.warn(
        { model: json.model },
        'ClaudeSubscriptionIntegration.query: empty completion',
      );
    }

    return {
      content,
      usage: json.usage,
      model: json.model ?? model,
    };
  }
}
