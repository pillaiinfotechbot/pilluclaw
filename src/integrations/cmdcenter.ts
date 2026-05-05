/**
 * WT-NC-08 — CMDCenter integration SDK (real HTTP).
 *
 * Replaces the WT-NC-07 mock with live POST/GET calls to CMDCenter.
 *
 * Methods:
 *   - score_lead({ session_id })            → POST /api/v1/leads/score
 *   - create_ticket({ session_id, subject, body? })
 *                                           → POST /api/v1/tickets
 *   - tag_session({ session_id, tag })      → POST /api/v1/sessions/:id/tags
 *   - fetch_chatbot_config()                → GET  /api/v1/chatbot/config
 *   - submit_lead({ ...lead })              → POST /api/v1/leads
 *
 * Auth: `X-Bot-Key` header from CMDCENTER_BOT_KEY (resolves
 * `${ONECLI:cmdcenter.pillubot_bot_key}` upstream — config-loader handles it).
 *
 * All methods throw on non-2xx so the workflow step fails clearly.
 * Per-method timeout default 30s, overridable via `timeout_ms` in input.
 */
import { logger } from '../logger.js';
import type { Integration, IntegrationMethod } from './registry.js';

export interface ScoreLeadInput {
  session_id: string;
  timeout_ms?: number;
}

export interface ScoreLeadOutput {
  session_id: string;
  score: number;
  band: 'cold' | 'warm' | 'hot';
}

export interface CreateTicketInput {
  session_id: string;
  subject: string;
  body?: string;
  timeout_ms?: number;
}

export interface CreateTicketOutput {
  ticket_id: string;
  session_id: string;
  status: string;
}

export interface TagSessionInput {
  session_id: string;
  tag: string;
  timeout_ms?: number;
}

export interface TagSessionOutput {
  session_id: string;
  tag: string;
  applied: boolean;
}

export interface SubmitLeadInput {
  session_id?: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  intent?: string;
  metadata?: Record<string, unknown>;
  timeout_ms?: number;
  // Allow caller to pass-through any other lead fields.
  [key: string]: unknown;
}

export interface SubmitLeadOutput {
  lead_id: string;
  session_id?: string;
  status: string;
}

export interface FetchChatbotConfigInput {
  timeout_ms?: number;
}

export interface FetchChatbotConfigOutput {
  system_prompt?: string;
  ai_model?: string;
  max_tokens?: number;
  catalog_text?: string;
  scope_definition?: string;
  [key: string]: unknown;
}

export class CmdCenterIntegration implements Integration {
  constructor(
    private readonly apiUrl: string = process.env.CMDCENTER_API_URL ?? '',
    private readonly botKey: string = process.env.CMDCENTER_BOT_KEY ?? '',
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  name(): string {
    return 'cmdcenter';
  }

  methods(): Record<string, IntegrationMethod> {
    return {
      score_lead: (input) => this.scoreLead(input as unknown as ScoreLeadInput),
      create_ticket: (input) =>
        this.createTicket(input as unknown as CreateTicketInput),
      tag_session: (input) =>
        this.tagSession(input as unknown as TagSessionInput),
      fetch_chatbot_config: (input) =>
        this.fetchChatbotConfig(input as FetchChatbotConfigInput),
      submit_lead: (input) => this.submitLead(input as SubmitLeadInput),
    };
  }

  async scoreLead(input: ScoreLeadInput): Promise<ScoreLeadOutput> {
    if (!input?.session_id) {
      throw new Error(
        'CmdCenterIntegration.score_lead: session_id is required',
      );
    }
    return this.post<ScoreLeadOutput>(
      '/api/v1/leads/score',
      { session_id: input.session_id },
      input.timeout_ms,
    );
  }

  async createTicket(input: CreateTicketInput): Promise<CreateTicketOutput> {
    if (!input?.session_id || !input?.subject) {
      throw new Error(
        'CmdCenterIntegration.create_ticket: session_id and subject are required',
      );
    }
    return this.post<CreateTicketOutput>(
      '/api/v1/tickets',
      {
        session_id: input.session_id,
        subject: input.subject,
        body: input.body,
      },
      input.timeout_ms,
    );
  }

  async tagSession(input: TagSessionInput): Promise<TagSessionOutput> {
    if (!input?.session_id || !input?.tag) {
      throw new Error(
        'CmdCenterIntegration.tag_session: session_id and tag are required',
      );
    }
    return this.post<TagSessionOutput>(
      `/api/v1/sessions/${encodeURIComponent(input.session_id)}/tags`,
      { tag: input.tag },
      input.timeout_ms,
    );
  }

  async fetchChatbotConfig(
    input: FetchChatbotConfigInput = {},
  ): Promise<FetchChatbotConfigOutput> {
    return this.get<FetchChatbotConfigOutput>(
      '/api/v1/chatbot/config',
      input.timeout_ms,
    );
  }

  async submitLead(input: SubmitLeadInput): Promise<SubmitLeadOutput> {
    // Strip the timeout out of the body — it's not a lead field.
    const { timeout_ms, ...lead } = input;
    return this.post<SubmitLeadOutput>('/api/v1/leads', lead, timeout_ms);
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    this.assertConfigured(path);
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? 30000),
    });
    return this.parse<T>(res, 'POST', path);
  }

  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    this.assertConfigured(path);
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(timeoutMs ?? 30000),
    });
    return this.parse<T>(res, 'GET', path);
  }

  private async parse<T>(
    res: {
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      json: () => Promise<unknown>;
    },
    method: string,
    path: string,
  ): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `CmdCenterIntegration: ${method} ${path} failed — HTTP ${res.status} — ${text.slice(0, 200)}`,
      );
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      logger.warn({ err, path }, 'CmdCenterIntegration: response was not JSON');
      throw new Error(
        `CmdCenterIntegration: ${method} ${path} returned non-JSON response`,
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Bot-Key': this.botKey,
    };
  }

  private assertConfigured(path: string): void {
    if (!this.apiUrl) {
      throw new Error(
        `CmdCenterIntegration: CMDCENTER_API_URL not set (called ${path})`,
      );
    }
    if (!this.botKey) {
      throw new Error(
        `CmdCenterIntegration: CMDCENTER_BOT_KEY not set (called ${path})`,
      );
    }
  }
}
