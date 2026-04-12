/**
 * Website Chat Poller — Manu & Maddy AI Chatbot Agents
 *
 * Connects to website SSE streams for instant pending-message pickup (~500ms),
 * with polling fallback if SSE disconnects. Keeps Claude CLI warm to reduce
 * cold-start latency.
 *
 * Flow:
 *   1. Subscribe to website SSE stream (/api/nanoclaw/chat/stream)
 *   2. On "pending" event → process immediately via `claude -p`
 *   3. POST reply back to website
 *   4. If SSE fails → fall back to polling every 5s
 *   5. Warm-up ping keeps Claude CLI process cached in memory
 *
 * Agents:
 *   Manu — manojmadhavan.com (personal brand, training, consulting)
 *   Maddy — pillaiinfotech.com (company services, products, support)
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { GROUPS_DIR } from './config.js';

// ── Config ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000; // fallback polling interval
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/mac/.local/bin/claude';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 60_000;
const WARMUP_INTERVAL_MS = 3 * 60 * 1000; // warm up Claude CLI every 3 minutes

// Quick acknowledgment messages — picked randomly for variety
const THINKING_REPLIES = [
  "Let me check that for you, one moment...",
  "Good question! Let me look into that...",
  "Sure, give me a moment to find the right info...",
  "Let me think about that for a second...",
  "One moment, checking on that for you...",
];

interface SiteConfig {
  name: string;
  agent: string;
  apiUrl: string;
  sseUrl: string;
  apiKey: string;
  groupFolder: string;
  systemPromptFile: string;
}

const SITES: SiteConfig[] = [
  {
    name: 'manojmadhavan.com',
    agent: 'Manu',
    apiUrl: 'https://manojmadhavan.com/api/nanoclaw/chat',
    sseUrl: 'https://manojmadhavan.com/api/nanoclaw/chat/stream',
    apiKey: 'manoj_nc_2026',
    groupFolder: 'website_manu',
    systemPromptFile: 'CLAUDE.md',
  },
  {
    name: 'pillaiinfotech.com',
    agent: 'Maddy',
    apiUrl: 'https://pillaiinfotech.com/api/nanoclaw/chat',
    sseUrl: 'https://pillaiinfotech.com/api/nanoclaw/chat/stream',
    apiKey: 'pillai_nc_2026',
    groupFolder: 'website_maddy',
    systemPromptFile: 'CLAUDE.md',
  },
];

// ── System prompt cache ──────────────────────────────────────────────────────

const systemPromptCache = new Map<string, { content: string; loadedAt: number }>();
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

function getSystemPrompt(site: SiteConfig): string {
  const cached = systemPromptCache.get(site.groupFolder);
  if (cached && Date.now() - cached.loadedAt < PROMPT_CACHE_TTL_MS) {
    return cached.content;
  }

  const promptPath = path.join(GROUPS_DIR, site.groupFolder, site.systemPromptFile);
  try {
    const content = fs.readFileSync(promptPath, 'utf-8');
    systemPromptCache.set(site.groupFolder, { content, loadedAt: Date.now() });
    return content;
  } catch (err) {
    logger.error({ err, path: promptPath }, `Failed to read system prompt for ${site.agent}`);
    return `You are ${site.agent}, an AI assistant for ${site.name}. Help visitors with their questions. Be concise, helpful, and direct. Use plain text without markdown formatting.`;
  }
}

// ── Claude CLI ──────────────────────────────────────────────────────────────

function getClaudeEnv(): NodeJS.ProcessEnv {
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const claudeEnv: NodeJS.ProcessEnv = { ...process.env };
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (secrets.ANTHROPIC_AUTH_TOKEN) {
    claudeEnv.ANTHROPIC_AUTH_TOKEN = secrets.ANTHROPIC_AUTH_TOKEN;
  } else if (secrets.ANTHROPIC_API_KEY) {
    claudeEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }
  return claudeEnv;
}

function askClaude(systemPrompt: string, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      CLAUDE_BIN,
      ['-p', '--model', CLAUDE_MODEL, '--system-prompt', systemPrompt, '--no-session-persistence'],
      {
        timeout: CLAUDE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        env: getClaudeEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `claude CLI error: ${error.message} stderr: ${stderr?.slice(0, 500)}`,
            ),
          );
          return;
        }
        const answer = stdout.trim();
        if (!answer) {
          reject(new Error('claude CLI returned empty response'));
          return;
        }
        resolve(answer);
      },
    );

    if (proc.stdin) {
      proc.stdin.write(question, 'utf8');
      proc.stdin.end();
    }
  });
}

// ── Claude CLI warm-up ──────────────────────────────────────────────────────

let lastWarmup = 0;

function warmupClaude(): void {
  const now = Date.now();
  if (now - lastWarmup < WARMUP_INTERVAL_MS) return;
  lastWarmup = now;

  const proc = execFile(
    CLAUDE_BIN,
    ['-p', '--model', CLAUDE_MODEL, '--system-prompt', 'Reply with just "ok".', '--no-session-persistence'],
    {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: getClaudeEnv(),
    },
    (error) => {
      if (error) {
        logger.warn({ err: error.message }, 'Claude CLI warmup failed');
      } else {
        logger.info('Claude CLI warmup: ok');
      }
    },
  );

  if (proc.stdin) {
    proc.stdin.write('ping', 'utf8');
    proc.stdin.end();
  }
}

// ── Dedup + reply helpers ───────────────────────────────────────────────────

const processedMessageIds = new Map<number, number>();
const PROCESS_TTL_MS = 2 * 60 * 60 * 1000;

function randomThinkingReply(): string {
  return THINKING_REPLIES[Math.floor(Math.random() * THINKING_REPLIES.length)];
}

async function postReply(site: SiteConfig, messageId: number, answer: string): Promise<boolean> {
  try {
    const res = await fetch(`${site.apiUrl}/${messageId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NANOCLAW-KEY': site.apiKey,
      },
      body: JSON.stringify({
        answer,
        message_id: messageId,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        { status: res.status, body: errText, messageId },
        'Website chat: reply failed',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, messageId }, 'Website chat: reply error');
    return false;
  }
}

// ── Message processing ──────────────────────────────────────────────────────

interface ConversationMessage {
  role: string;
  content: string;
}

interface SessionContext {
  intent: string;
  label: string;
  page: string;
  page_data?: {
    hourly_rate_usd?: { min: number; max: number };
    monthly_dedicated_usd?: { min: number; max: number };
    engagement_models?: string[];
    availability?: string;
    skills?: string[];
    experience_levels?: string[];
  };
  journey?: {
    pages_visited: string[];
    sections_viewed: string[];
    time_on_page_s: number;
    scroll_depth: number;
    engagement_score: number;
  };
}

interface PendingMessage {
  id: number;
  session_id: string;
  content: string;
  source: string;
  created_at: string;
  conversation_history: ConversationMessage[];
  session_context?: SessionContext;   // NEW
}

async function processMessage(
  site: SiteConfig,
  systemPrompt: string,
  msg: PendingMessage,
): Promise<void> {
  logger.info(
    {
      site: site.name,
      agent: site.agent,
      messageId: msg.id,
      sessionId: msg.session_id,
      intent: msg.session_context?.intent,
      content: msg.content.substring(0, 100),
    },
    'Website chat: processing message',
  );

  let question = '';

  // ── Visitor context block ────────────────────────────────────────────────
  if (msg.session_context?.intent) {
    const ctx = msg.session_context;
    const pd  = ctx.page_data;
    const j   = ctx.journey;

    question += '[VISITOR CONTEXT]\n';
    question += `Intent: ${ctx.label} (CTA on ${ctx.page})\n`;

    if (pd) {
      if (pd.hourly_rate_usd) {
        question += `Rates: $${pd.hourly_rate_usd.min}–$${pd.hourly_rate_usd.max}/hr`;
        if (pd.monthly_dedicated_usd) {
          question += ` | $${pd.monthly_dedicated_usd.min.toLocaleString()}–$${pd.monthly_dedicated_usd.max.toLocaleString()}/mo dedicated`;
        }
        question += '\n';
      }
      if (pd.availability)              question += `Availability: ${pd.availability}\n`;
      if (pd.skills?.length)            question += `Skills: ${pd.skills.join(', ')}\n`;
      if (pd.engagement_models?.length) question += `Engagement: ${pd.engagement_models.join(', ')}\n`;
      if (pd.experience_levels?.length) question += `Levels: ${pd.experience_levels.join(', ')}\n`;
    }

    if (j) {
      if (j.pages_visited?.length)   question += `Pages: ${j.pages_visited.join(' → ')}\n`;
      if (j.sections_viewed?.length) question += `Sections read: ${j.sections_viewed.join(', ')}\n`;
      if (j.time_on_page_s)          question += `Time on page: ${Math.round((j.time_on_page_s / 60) * 10) / 10} min\n`;
      if (j.scroll_depth)            question += `Scroll: ${j.scroll_depth}%\n`;
      if (j.engagement_score != null) question += `Engagement: ${j.engagement_score}/100\n`;
    }

    question += '[END CONTEXT]\n\n';
  }

  // ── Conversation history ─────────────────────────────────────────────────
  const history = msg.conversation_history || [];
  if (history.length > 0) {
    question += 'Conversation so far:\n';
    for (const h of history) {
      const role = h.role === 'user' ? 'Visitor' : site.agent;
      question += `${role}: ${h.content}\n`;
    }
    question += '\nVisitor: ';
  }

  // ── Current message ──────────────────────────────────────────────────────
  if (msg.source === 'intent_trigger' || msg.content.startsWith('__INTENT:')) {
    // Hidden trigger — instruct to generate opening greeting
    question += '(Visitor just opened chat from this CTA. Generate your opening greeting based on the visitor context above. Do not mention "intent trigger" or tracking — greet them naturally by their interest.)';
  } else {
    question += msg.content;
  }

  const answer = await askClaude(systemPrompt, question);
  const sent   = await postReply(site, msg.id, answer);

  if (sent) {
    logger.info(
      {
        site: site.name,
        agent: site.agent,
        messageId: msg.id,
        answerLength: answer.length,
      },
      'Website chat: reply sent',
    );
  }
}

function handlePendingMessages(site: SiteConfig, pending: PendingMessage[]): void {
  const now = Date.now();

  // Cleanup old dedup entries
  for (const [id, ts] of processedMessageIds) {
    if (now - ts > PROCESS_TTL_MS) processedMessageIds.delete(id);
  }

  const systemPrompt = getSystemPrompt(site);

  for (const msg of pending) {
    if (processedMessageIds.has(msg.id)) continue;
    processedMessageIds.set(msg.id, now);

    processMessage(site, systemPrompt, msg).catch((err) => {
      logger.error(
        { err, site: site.name, messageId: msg.id },
        'Website chat: error processing message',
      );
      processedMessageIds.delete(msg.id);
    });
  }
}

// ── SSE connection per site ─────────────────────────────────────────────────

const sseConnections = new Map<string, { abort: AbortController; active: boolean }>();

async function connectSSE(site: SiteConfig): Promise<void> {
  // Abort any existing connection
  const existing = sseConnections.get(site.name);
  if (existing) {
    existing.abort.abort();
  }

  const abort = new AbortController();
  sseConnections.set(site.name, { abort, active: true });

  logger.info({ site: site.name }, 'Website chat: SSE connecting');

  try {
    const res = await fetch(site.sseUrl, {
      headers: { 'X-NANOCLAW-KEY': site.apiKey },
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      logger.warn({ site: site.name, status: res.status }, 'Website chat: SSE connection failed');
      sseConnections.set(site.name, { abort, active: false });
      return;
    }

    logger.info({ site: site.name }, 'Website chat: SSE connected');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      let eventType = '';
      let dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
        } else if (line === '' && dataLines.length > 0) {
          // End of event — process it
          const data = dataLines.join('\n');
          dataLines = [];

          if (eventType === 'pending') {
            try {
              const parsed = JSON.parse(data) as { pending: PendingMessage[] };
              if (parsed.pending && parsed.pending.length > 0) {
                handlePendingMessages(site, parsed.pending);
              }
            } catch (parseErr) {
              logger.error({ err: parseErr, site: site.name }, 'Website chat: SSE parse error');
            }
          } else if (eventType === 'timeout') {
            // Server closed stream — reconnect
            break;
          }

          eventType = '';
        } else if (line.startsWith(':')) {
          // Comment / keepalive — ignore
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') return; // intentional disconnect
    logger.warn({ err: err?.message, site: site.name }, 'Website chat: SSE error');
  } finally {
    sseConnections.set(site.name, { abort, active: false });
  }
}

// ── SSE reconnect loop per site ─────────────────────────────────────────────

async function sseLoop(site: SiteConfig): Promise<void> {
  while (true) {
    await connectSSE(site);
    // Wait 2s before reconnecting (backoff)
    await new Promise((r) => setTimeout(r, 2000));
    logger.info({ site: site.name }, 'Website chat: SSE reconnecting');
  }
}

// ── Fallback polling (unchanged, used if SSE is down) ───────────────────────

async function pollSite(site: SiteConfig): Promise<void> {
  // Skip polling if SSE is active for this site
  const conn = sseConnections.get(site.name);
  if (conn?.active) return;

  try {
    const pollRes = await fetch(site.apiUrl, {
      headers: { 'X-NANOCLAW-KEY': site.apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    if (!pollRes.ok) {
      logger.warn(
        { status: pollRes.status, site: site.name },
        'Website chat: poll failed',
      );
      return;
    }

    const pollData = (await pollRes.json()) as {
      success: boolean;
      pending: PendingMessage[];
    };

    if (!pollData.success || !pollData.pending || pollData.pending.length === 0) {
      return;
    }

    handlePendingMessages(site, pollData.pending);
  } catch (err) {
    logger.error({ err, site: site.name }, 'Website chat: poll error');
  }
}

async function pollAll(): Promise<void> {
  await Promise.allSettled(SITES.map((site) => pollSite(site)));
}

// ── Main ────────────────────────────────────────────────────────────────────

export function startWebsiteChatPoller(): void {
  logger.info(
    {
      sites: SITES.map((s) => s.name),
      mode: 'SSE primary, polling fallback',
      claudeBin: CLAUDE_BIN,
    },
    'Website chat poller started',
  );

  // Start SSE connections for each site (primary — instant pickup)
  for (const site of SITES) {
    sseLoop(site).catch((err) => {
      logger.error({ err, site: site.name }, 'Website chat: SSE loop crashed');
    });
  }

  // Fallback polling — only runs when SSE is disconnected
  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);

  // Warm up Claude CLI immediately, then every 3 minutes
  warmupClaude();
  setInterval(warmupClaude, WARMUP_INTERVAL_MS);
}
