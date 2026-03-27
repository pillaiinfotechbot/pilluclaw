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
import { storeMessageDirect, getAllRegisteredGroups } from './db.js';
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
};

// Track which task IDs we've already injected, with injection timestamp.
// Entries expire after INJECT_TTL_MS so stale/failed tasks get re-injected.
const INJECT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const injectedTaskIds = new Map<number, number>(); // taskId → injectedAt (ms)

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

    let injected = 0;
    for (const task of tasks) {
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
}

async function fetchPendingNanoclawTasks(): Promise<CmdCenterTask[]> {
  const url = `${CMDCENTER_API_URL}/tasks?status=in_progress&limit=20`;
  const res = await fetch(url, {
    headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`CMDCenter API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    data: CmdCenterTask[];
  };

  if (!data.success || !Array.isArray(data.data)) return [];

  // Only return tasks assigned to known nanoclaw agents
  return data.data.filter(
    (t) => t.assigned_agent && t.assigned_agent in AGENT_TO_FOLDER,
  );
}
