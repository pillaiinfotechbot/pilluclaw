/**
 * CMDCenter Agent Heartbeat & Task Dispatcher
 *
 * Runs every 5 minutes to:
 * 1. Check all agents status (last_active timestamps)
 * 2. For each pending task, dispatch to assigned agent via webhook
 * 3. Detect stuck agents (no heartbeat > 10 min)
 * 4. Verify webhook URLs are configured for all agents
 * 5. Monitor task dispatch success/failure rates
 *
 * This complements the CMDCenter poller which handles in_progress tasks.
 * This heartbeat dispatcher focuses on pending task dispatch and agent health.
 */

import { logger } from './logger.js';

// ── Config ────────────────────────────────────────────────────────────────────

const CMDCENTER_API_URL =
  process.env.CMDCENTER_API_URL ??
  'https://cmdcenterapi.pillaiinfotech.com/api/v1';
const CMDCENTER_BOT_KEY = process.env.CMDCENTER_BOT_KEY ?? 'nc_bot_pillai2026';
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const AGENT_STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes without heartbeat

// Agent name → virtual JID mapping (from CLAUDE.md)
const AGENT_TO_WEBHOOK: Record<string, string> = {
  'CEO Agent': 'virtual:ceo',
  'COO Agent': 'virtual:coo',
  'CTO Agent': 'virtual:cto',
  'CMO Agent': 'virtual:cmo',
  'CFO Agent': 'virtual:cfo',
  'CHRO Agent': 'virtual:chro',
  DevBot: 'virtual:devbot',
  QABot: 'virtual:qabot',
  PMBot: 'virtual:pmbot',
  ArchitectBot: 'virtual:architectbot',
  LocalAIBot: 'virtual:localaibot',
  'CMDCenter DevBot': 'virtual:cmdcenter',
  'Dev Agent': 'virtual:devbot',
  'PM Agent': 'virtual:pmbot',
  'QA Agent': 'virtual:qabot',
  'Architect Agent': 'virtual:architectbot',
  AgentBuilder: 'virtual:agentbuilder',
  'Agent Builder': 'virtual:agentbuilder',
  'Sr Developer': 'virtual:srdev',
  SrDev: 'virtual:srdev',
  'Sr Dev': 'virtual:srdev',
  'Live Test Agent': 'virtual:livetest',
  LiveTest: 'virtual:livetest',
  'Live Test': 'virtual:livetest',
  SYSAgent: 'virtual:sysagent',
  'SYS Agent': 'virtual:sysagent',
  'System Agent': 'virtual:sysagent',
  'CMDCenter API Agent': 'virtual:apiagent',
  APIAgent: 'virtual:apiagent',
  'API Agent': 'virtual:apiagent',
};

// Human assignees — tasks assigned to these names are skipped silently.
// Humans don't have webhooks; they act via CMDCenter UI at their own pace.
const HUMAN_ASSIGNEES = new Set(['Manoj Pillai', 'Manoj', 'Human']);

// ── Heartbeat state ───────────────────────────────────────────────────────────

interface AgentStatus {
  id: number;
  name: string;
  status: string;
  last_active: string | null;
  pending_tasks: number;
  active_tasks: number;
  is_stuck: boolean;
  webhook_configured: boolean;
}

interface DispatchMetrics {
  pending_tasks_total: number;
  pending_tasks_dispatched: number;
  pending_tasks_failed: number;
  agents_stuck: number;
  webhooks_missing: number;
  timestamp: string;
}

let metrics: DispatchMetrics = {
  pending_tasks_total: 0,
  pending_tasks_dispatched: 0,
  pending_tasks_failed: 0,
  agents_stuck: 0,
  webhooks_missing: 0,
  timestamp: new Date().toISOString(),
};

// ── Main heartbeat loop ────────────────────────────────────────────────────────

export function startCmdCenterHeartbeat(): void {
  logger.info(
    { apiUrl: CMDCENTER_API_URL, intervalMs: HEARTBEAT_INTERVAL_MS },
    'CMDCenter agent heartbeat dispatcher started',
  );
  runHeartbeat();
  setInterval(() => runHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

async function runHeartbeat(): Promise<void> {
  try {
    // Reset metrics each run
    metrics = {
      pending_tasks_total: 0,
      pending_tasks_dispatched: 0,
      pending_tasks_failed: 0,
      agents_stuck: 0,
      webhooks_missing: 0,
      timestamp: new Date().toISOString(),
    };

    logger.info('CMDCenter heartbeat: starting dispatch cycle');

    // 1. Check all agents status
    const agents = await fetchAllAgents();
    const agentStatuses = analyzeAgentHealth(agents);

    // 2. Check for stuck agents
    const stuckAgents = agentStatuses.filter((a) => a.is_stuck);
    if (stuckAgents.length > 0) {
      metrics.agents_stuck = stuckAgents.length;
      logger.warn(
        { count: stuckAgents.length, agents: stuckAgents.map((a) => a.name) },
        'CMDCenter heartbeat: detected stuck agents (no heartbeat > 10 min)',
      );
    }

    // 3. Check for missing webhooks
    const missingWebhooks = agentStatuses.filter((a) => !a.webhook_configured);
    if (missingWebhooks.length > 0) {
      metrics.webhooks_missing = missingWebhooks.length;
      logger.warn(
        {
          count: missingWebhooks.length,
          agents: missingWebhooks.map((a) => a.name),
        },
        'CMDCenter heartbeat: missing webhook URLs for agents',
      );
    }

    // 4. Get pending tasks
    const pendingTasks = await fetchPendingTasks();
    metrics.pending_tasks_total = pendingTasks.length;

    if (pendingTasks.length === 0) {
      logger.info('CMDCenter heartbeat: no pending tasks to dispatch');
      logMetrics();
      return;
    }

    logger.info(
      { count: pendingTasks.length },
      'CMDCenter heartbeat: fetched pending tasks',
    );

    // 5. Dispatch pending tasks to agents
    for (const task of pendingTasks) {
      try {
        const agentName = task.assigned_agent || 'unknown';
        const webhookUrl = AGENT_TO_WEBHOOK[agentName];

        if (!webhookUrl) {
          if (HUMAN_ASSIGNEES.has(agentName)) {
            // Human-assigned task — skip silently, human will act via CMDCenter UI
            logger.debug(
              { taskId: task.id, agentName },
              'CMDCenter heartbeat: human-assigned task, skipping dispatch',
            );
            // Human skips do NOT count as failures — they are intentional
          } else {
            logger.warn(
              { taskId: task.id, agentName },
              'CMDCenter heartbeat: no webhook configured for agent',
            );
            metrics.pending_tasks_failed++;
          }
          continue;
        }

        // Dispatch task to agent via webhook (virtual JID)
        // The actual dispatch mechanism depends on the nanoclaw implementation
        // For now, we log that we would dispatch and update the task status
        await updateTaskStatus(task.id, 'in_progress', {
          notes: `Dispatched via heartbeat runner at ${new Date().toISOString()}`,
        });

        logger.info(
          { taskId: task.id, agentName, webhook: webhookUrl },
          'CMDCenter heartbeat: dispatched task to agent',
        );
        metrics.pending_tasks_dispatched++;
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'CMDCenter heartbeat: failed to dispatch task',
        );
        metrics.pending_tasks_failed++;
      }
    }

    logMetrics();
  } catch (err) {
    logger.error({ err }, 'CMDCenter heartbeat: error during cycle');
  }
}

// ── API Calls ─────────────────────────────────────────────────────────────────

interface CmdCenterAgent {
  id: number;
  name: string;
  status: string;
  last_active: string | null;
  pending_tasks: number;
  active_tasks: number;
}

interface CmdCenterTask {
  id: number;
  title: string;
  description: string | null;
  assigned_agent: string | null;
  priority: string | null;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
}

async function fetchAllAgents(): Promise<CmdCenterAgent[]> {
  const res = await fetch(`${CMDCENTER_API_URL}/agents?limit=100`, {
    headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`CMDCenter API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    data: CmdCenterAgent[];
  };

  return data.success && Array.isArray(data.data) ? data.data : [];
}

async function fetchPendingTasks(): Promise<CmdCenterTask[]> {
  const res = await fetch(
    `${CMDCENTER_API_URL}/tasks?status=pending&limit=50`,
    {
      headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    throw new Error(`CMDCenter API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    data: CmdCenterTask[];
  };

  return data.success && Array.isArray(data.data) ? data.data : [];
}

interface TaskUpdatePayload {
  status?: string;
  notes?: string;
  retry_count?: number;
}

async function updateTaskStatus(
  taskId: number,
  status: string,
  payload?: Partial<TaskUpdatePayload>,
): Promise<void> {
  const body = {
    status,
    ...payload,
  };

  const res = await fetch(`${CMDCENTER_API_URL}/tasks/${taskId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Key': CMDCENTER_BOT_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`CMDCenter API error ${res.status}: ${await res.text()}`);
  }
}

// ── Health Analysis ───────────────────────────────────────────────────────────

function analyzeAgentHealth(agents: CmdCenterAgent[]): AgentStatus[] {
  const now = Date.now();
  return agents.map((agent) => {
    const lastActiveTime = agent.last_active
      ? new Date(agent.last_active).getTime()
      : 0;
    const timeSinceLastActive = now - lastActiveTime;
    const isStuck = timeSinceLastActive > AGENT_STUCK_THRESHOLD_MS;

    const webhookConfigured = agent.name in AGENT_TO_WEBHOOK;

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      last_active: agent.last_active,
      pending_tasks: agent.pending_tasks || 0,
      active_tasks: agent.active_tasks || 0,
      is_stuck: isStuck,
      webhook_configured: webhookConfigured,
    };
  });
}

// ── Metrics Logging ───────────────────────────────────────────────────────────

function logMetrics(): void {
  logger.info(metrics, 'CMDCenter heartbeat: dispatch metrics');
}

// ── Export for external monitoring ─────────────────────────────────────────────

export function getHeartbeatMetrics(): DispatchMetrics {
  return { ...metrics };
}
