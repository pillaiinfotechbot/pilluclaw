/**
 * CMDCenter Task Poller
 *
 * Polls the CMDCenter API for tasks delegated to nanoclaw bots and injects
 * them directly into the nanoclaw message queue. This is needed because
 * Telegram bots cannot receive their own messages via getUpdates — so the
 * PHP heartbeat's Telegram delivery never reaches nanoclaw.
 *
 * Flow:
 *   1. Every POLL_INTERVAL ms, fetch in_progress tasks from CMDCenter
 *   2. Filter to tasks assigned to known nanoclaw agents
 *   3. If not already processed, inject a trigger message into the group DB
 *   4. Enqueue the group for processing
 *   5. The agent marks the task executed via CMDCenter API when done
 */

import { randomUUID } from 'crypto';

import { logger } from './logger.js';
import {
  storeMessageDirect,
  storeChatMetadata,
  getAllRegisteredGroups,
} from './db.js';
import { GroupQueue } from './group-queue.js';

// ── Config ────────────────────────────────────────────────────────────────────

const CMDCENTER_API_URL =
  process.env.CMDCENTER_API_URL ??
  'https://cmdcenterapi.pillaiinfotech.com/api/v1';
const CMDCENTER_BOT_KEY = process.env.CMDCENTER_BOT_KEY ?? 'nc_bot_pillai2026';
const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

// Mapping: CMDCenter assigned_agent → nanoclaw group folder
// Matches the $nanoclawAgents array in cron_agent_heartbeat.php
const AGENT_TO_FOLDER: Record<string, string> = {
  'CEO Agent': 'telegram_ceo',
  'COO Agent': 'telegram_coo',
  'CTO Agent': 'telegram_cto',
  'CMO Agent': 'telegram_cmo',
  'CFO Agent': 'telegram_cfo',
  'CHRO Agent': 'telegram_chro',
  DevBot: 'telegram_devbot',
  QABot: 'telegram_qabot',
  PMBot: 'telegram_pmbot',
  ArchitectBot: 'telegram_architectbot',
  LocalAIBot: 'telegram_localaibot',
  'CMDCenter DevBot': 'telegram_cmdcenter',
  'Dev Agent': 'telegram_devbot',
  'PM Agent': 'telegram_pmbot',
  'QA Agent': 'telegram_qabot',
  'Architect Agent': 'telegram_architectbot',
  AgentBuilder: 'telegram_agentbuilder',
  'Agent Builder': 'telegram_agentbuilder',
  'Sr Developer': 'telegram_srdev',
  SrDev: 'telegram_srdev',
  'Sr Dev': 'telegram_srdev',
  'Live Test Agent': 'telegram_livetest',
  LiveTest: 'telegram_livetest',
  'Live Test': 'telegram_livetest',
  SYSAgent: 'telegram_sysagent',
  'SYS Agent': 'telegram_sysagent',
  'System Agent': 'telegram_sysagent',
};

// Trigger prefix per folder (must match registered_groups trigger_pattern)
const FOLDER_TO_TRIGGER: Record<string, string> = {
  telegram_ceo: '/ceo',
  telegram_coo: '/coo',
  telegram_cto: '/cto',
  telegram_cmo: '/cmo',
  telegram_cfo: '/cfo',
  telegram_chro: '/chro',
  telegram_devbot: '/devbot',
  telegram_qabot: '/qabot',
  telegram_pmbot: '/pmbot',
  telegram_architectbot: '/architectbot',
  telegram_localaibot: '/localai',
  telegram_cmdcenter: '@CMDBot',
  telegram_agentbuilder: '/agentbuilder',
  telegram_srdev: '/srdev',
  telegram_livetest: '/livetest',
  telegram_sysagent: '/sysagent',
};

// Track which task IDs we've already injected, with injection timestamp.
// Entries expire after INJECT_TTL_MS so stale/failed tasks get re-injected.
const INJECT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const injectedTaskIds = new Map<number, number>(); // taskId → injectedAt (ms)

// Terminal statuses — never re-inject regardless of TTL
const TERMINAL_STATUSES = new Set(['passed', 'in_testing']);

// Statuses that only LiveTest should receive
const LIVETEST_ONLY_STATUSES = new Set(['completed']);

// ── Main poller ───────────────────────────────────────────────────────────────

export function startCmdCenterPoller(queue: GroupQueue): void {
  logger.info(
    { apiUrl: CMDCENTER_API_URL, intervalMs: POLL_INTERVAL_MS },
    'CMDCenter task poller started',
  );
  pollOnce(queue);
  setInterval(() => pollOnce(queue), POLL_INTERVAL_MS);
}

async function pollOnce(queue: GroupQueue): Promise<void> {
  try {
    const tasks = await fetchPendingNanoclawTasks();
    if (tasks.length === 0) return;

    const registeredGroups = getAllRegisteredGroups();

    // Build folder → JID reverse lookup
    const folderToJid = new Map<string, string>();
    for (const [jid, groups] of Object.entries(registeredGroups)) {
      for (const group of groups) {
        folderToJid.set(group.folder, jid);
      }
    }

    // Sort tasks by weighted priority score — highest urgency first
    const sortedTasks = [...tasks].sort((a, b) => scoreTask(b) - scoreTask(a));

    let injected = 0;
    for (const task of sortedTasks) {
      const agentName: string = task.assigned_agent ?? '';
      const folder = AGENT_TO_FOLDER[agentName];
      if (!folder) continue; // not a nanoclaw agent

      const jid = folderToJid.get(folder);
      if (!jid) {
        logger.warn(
          { agentName, folder },
          'CMDCenter poller: no JID for folder — group not registered',
        );
        continue;
      }

      // Skip terminal statuses — task is fully done, no agent action needed
      if (TERMINAL_STATUSES.has(task.status)) continue;

      // completed tasks are only for LiveTest — skip for all other agents
      if (
        LIVETEST_ONLY_STATUSES.has(task.status) &&
        folder !== 'telegram_livetest'
      )
        continue;

      // Skip if recently injected (within TTL window) — prevents duplicate queuing
      const lastInjected = injectedTaskIds.get(task.id);
      if (lastInjected && Date.now() - lastInjected < INJECT_TTL_MS) continue;

      // Respect max_retries: if exhausted, skip (heartbeat/watchdog will escalate)
      const retryCount = task.retry_count ?? 0;
      const maxRetries = task.max_retries ?? 3;
      if (retryCount >= maxRetries) {
        logger.warn(
          { taskId: task.id, retryCount, maxRetries },
          'CMDCenter poller: task max retries exceeded — skipping (heartbeat will escalate)',
        );
        continue;
      }

      const trigger = FOLDER_TO_TRIGGER[folder] ?? '/cmd';
      const priority = (task.priority ?? 'medium').toUpperCase();
      const content =
        `${trigger} 📋 Task #${task.id} [${priority}]: ${task.title}\n\n` +
        (task.description ? `${task.description}\n\n` : '') +
        `---\nWhen done, mark task as executed:\n` +
        `PUT ${CMDCENTER_API_URL}/tasks/${task.id}\n` +
        `X-Bot-Key: ${CMDCENTER_BOT_KEY}\n` +
        `{"status":"executed","result":"<your summary>"}`;

      // Ensure the chat JID exists in chats table before inserting message (FOREIGN KEY constraint)
      storeChatMetadata(jid, new Date().toISOString());

      storeMessageDirect({
        id: `cmdcenter-task-${task.id}-${randomUUID()}`,
        chat_jid: jid,
        sender: 'cmdcenter-poller',
        sender_name: 'CMDCenter',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: false,
      });

      queue.enqueueMessageCheck(jid);
      injectedTaskIds.set(task.id, Date.now());
      injected++;

      logger.info(
        { taskId: task.id, agentName, folder, jid },
        'CMDCenter poller: injected task into group queue',
      );
    }

    if (injected > 0) {
      logger.info({ injected }, 'CMDCenter poller: tasks queued');
    }
  } catch (err) {
    logger.error({ err }, 'CMDCenter poller: poll error');
  }
}

// ── CMDCenter API ─────────────────────────────────────────────────────────────

interface CmdCenterTask {
  id: number;
  title: string;
  description: string | null;
  assigned_agent: string | null;
  priority: string | null;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
  project_id: number | null;
  deadline: string | null;
}

// ── Weighted Priority Scoring ─────────────────────────────────────────────────
// Score = Priority Weight + Project Weight + Deadline Weight
// Higher score = higher urgency, processed first

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 40,
  high: 30,
  medium: 20,
  low: 10,
};

function scoreTask(task: CmdCenterTask): number {
  const priorityScore =
    PRIORITY_WEIGHT[(task.priority ?? 'medium').toLowerCase()] ?? 20;

  // Deadline weight: check how close the deadline is
  let deadlineScore = 0;
  if (task.deadline) {
    const now = Date.now();
    const deadline = new Date(task.deadline).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysUntil = (deadline - now) / msPerDay;
    if (daysUntil < 0)
      deadlineScore = 40; // overdue
    else if (daysUntil < 1)
      deadlineScore = 30; // due today
    else if (daysUntil <= 7)
      deadlineScore = 20; // due this week
    else deadlineScore = 0; // later
  }

  return priorityScore + deadlineScore;
}

async function fetchPendingNanoclawTasks(): Promise<CmdCenterTask[]> {
  // Fetch both pending AND in_progress tasks.
  // Since we migrated away from the PHP heartbeat cron (cron #2 is disabled),
  // NanoClaw now handles the full task lifecycle:
  //   pending → inject message → in_progress → executed → review → completed
  // This replaces the old flow where the PHP cron transitioned pending → in_progress.
  // Do NOT fetch executed/review/completed/rejected: those are terminal stages.

  const allTasks: CmdCenterTask[] = [];

  // Fetch pending tasks
  try {
    const pendingRes = await fetch(
      `${CMDCENTER_API_URL}/tasks?status=pending&limit=50`,
      {
        headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (pendingRes.ok) {
      const data = (await pendingRes.json()) as {
        success: boolean;
        data: CmdCenterTask[];
      };
      if (data.success && Array.isArray(data.data)) {
        allTasks.push(...data.data);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to fetch pending tasks');
  }

  // Fetch in_progress tasks
  try {
    const inProgressRes = await fetch(
      `${CMDCENTER_API_URL}/tasks?status=in_progress&limit=50`,
      {
        headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (inProgressRes.ok) {
      const data = (await inProgressRes.json()) as {
        success: boolean;
        data: CmdCenterTask[];
      };
      if (data.success && Array.isArray(data.data)) {
        allTasks.push(...data.data);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to fetch in_progress tasks');
  }

  // Safety guard: never re-dispatch terminal statuses even if the API returns them
  const TERMINAL_STATUSES = new Set([
    'executed',
    'review',
    'completed',
    'rejected',
    'cancelled',
  ]);

  // Only return tasks assigned to known nanoclaw agents and not in terminal state
  return allTasks.filter(
    (t) =>
      t.assigned_agent &&
      t.assigned_agent in AGENT_TO_FOLDER &&
      !TERMINAL_STATUSES.has(t.status),
  );
}
