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
      // ── Determine which agent handles this task at its current stage ──
      const { agentName, role } = resolveAgentForStage(task);
      if (!agentName) continue;

      const folder = AGENT_TO_FOLDER[agentName];
      if (!folder) continue;

      const jid = folderToJid.get(folder);
      if (!jid) {
        logger.warn(
          { agentName, folder },
          'CMDCenter poller: no JID for folder',
        );
        continue;
      }

      if (TERMINAL_STATUSES.has(task.status)) continue;
      if (
        LIVETEST_ONLY_STATUSES.has(task.status) &&
        folder !== 'telegram_livetest'
      )
        continue;

      const lastInjected = injectedTaskIds.get(task.id);
      if (lastInjected && Date.now() - lastInjected < INJECT_TTL_MS) continue;

      const retryCount = task.retry_count ?? 0;
      const maxRetries = task.max_retries ?? 3;
      if (retryCount >= maxRetries) {
        logger.warn(
          { taskId: task.id, retryCount, maxRetries },
          'Task max retries exceeded',
        );
        continue;
      }

      const trigger = FOLDER_TO_TRIGGER[folder] ?? '/cmd';
      const priority = (task.priority ?? 'medium').toUpperCase();
      const content = buildTaskPrompt(trigger, priority, task, role);

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
        { taskId: task.id, agentName, role, folder, jid },
        'CMDCenter poller: injected task',
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
  definition_of_completed: string | null;
  assigned_agent: string | null;
  qa_agent: string | null;
  reviewer_agent: string | null;
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

// ── Stage routing ─────────────────────────────────────────────────────────────

/**
 * Determine which agent acts on a task at its current pipeline stage.
 *
 * Stage 1 — Executor:  pending / in_progress  → assigned_agent
 * Stage 2 — QA:        executed               → qa_agent (default: QA Agent)
 * Stage 3 — Reviewer:  review                 → reviewer_agent (default: Sr Developer)
 */
function resolveAgentForStage(task: CmdCenterTask): {
  agentName: string | null;
  role: 'executor' | 'qa' | 'reviewer';
} {
  const s = task.status;
  if (s === 'pending' || s === 'in_progress') {
    return { agentName: task.assigned_agent, role: 'executor' };
  }
  if (s === 'executed') {
    return { agentName: task.qa_agent ?? 'QA Agent', role: 'qa' };
  }
  if (s === 'review') {
    return {
      agentName: task.reviewer_agent ?? 'Sr Developer',
      role: 'reviewer',
    };
  }
  return { agentName: null, role: 'executor' };
}

/**
 * Build the task prompt for the target agent based on their pipeline role.
 */
function buildTaskPrompt(
  trigger: string,
  priority: string,
  task: CmdCenterTask,
  role: 'executor' | 'qa' | 'reviewer',
): string {
  const base =
    `${trigger} 📋 Task #${task.id} [${priority}]: ${task.title}\n\n` +
    (task.description ? `${task.description}\n\n` : '');

  const dod = task.definition_of_completed
    ? `## Definition of Done\n${task.definition_of_completed}\n\n`
    : '';

  // Common API reference block included in every prompt
  const apiRef =
    `\n\n---\n## CMDCenter API Reference\nBase: ${CMDCENTER_API_URL}\nHeader: X-Bot-Key: ${CMDCENTER_BOT_KEY}\n\n` +
    `### Read task + steps + notes\n` +
    `GET /tasks/${task.id}          → full task with steps array\n` +
    `GET /tasks/${task.id}/notes    → all agent notes (chronological)\n` +
    `GET /tasks/${task.id}/communications → full agent↔LLM exchange log\n\n` +
    `### Log communication (call this for EVERY significant action/thought)\n` +
    `POST /tasks/${task.id}/communication\n` +
    `{"agent":"<YourName>","msg_type":"thinking|request|response|note|error","direction":"agent|llm|system",\n` +
    ` "content":"<your thought/action/result>","step_id":<step_id or null>,\n` +
    ` "tokens_in":<N>,"tokens_out":<N>,"cost":<USD float>,"model_used":"<model>"}\n\n` +
    `### Update a step\n` +
    `PUT /steps/<step_id>\n` +
    `{"status":"in_progress|completed|failed","output":"<result>","assigned_agent":"<YourName>",\n` +
    ` "cost":<USD>,"tokens_in":<N>,"tokens_out":<N>,"model_used":"<model>","duration_ms":<ms>}\n`;

  if (role === 'executor') {
    return (
      base +
      dod +
      `---\n` +
      `You are the **Executor**. Your job:\n` +
      `1. GET /tasks/${task.id} — read the full task + steps\n` +
      `2. Work through EACH step in order:\n` +
      `   a. PUT /steps/<step_id> {"status":"in_progress","assigned_agent":"${task.assigned_agent ?? 'Agent'}"}\n` +
      `   b. Do the work for the step\n` +
      `   c. PUT /steps/<step_id> {"status":"completed","output":"<result>","cost":<USD>,...}\n` +
      `   d. POST /tasks/${task.id}/communication {"agent":"${task.assigned_agent ?? 'Agent'}","msg_type":"note","content":"Step <N> done: <what/why/how>"}\n` +
      `3. After ALL steps done, add a note summarising your work:\n` +
      `POST /tasks/${task.id}/note {"agent":"${task.assigned_agent ?? 'Agent'}","stage":"executed","note":"<summary of what was done>"}\n` +
      `4. Mark the task executed:\n` +
      `PUT /tasks/${task.id} {"status":"executed","thinking_log":"<detailed result>"}` +
      apiRef
    );
  }

  if (role === 'qa') {
    return (
      base +
      dod +
      `---\n` +
      `You are the **QA Agent**. This task has been executed — validate every step against the Definition of Done.\n\n` +
      `1. GET /tasks/${task.id} — read full task, steps, and their outputs\n` +
      `2. GET /tasks/${task.id}/notes — read executor notes\n` +
      `3. For EACH step, verify the output matches its acceptance criteria\n` +
      `4. Log your findings per step:\n` +
      `POST /tasks/${task.id}/communication {"agent":"QA Agent","msg_type":"note","content":"Step <N> QA: <pass/fail + reason>"}\n\n` +
      `5. Add overall QA note:\n` +
      `POST /tasks/${task.id}/note {"agent":"QA Agent","stage":"qa_check","note":"QA findings: <detailed>"}\n\n` +
      `# If ALL steps PASS:\n` +
      `PUT /tasks/${task.id} {"status":"review","thinking_log":"✅ QA PASS: <summary>"}\n\n` +
      `# If ANY step FAILS:\n` +
      `PUT /tasks/${task.id} {"status":"pending","rejected_reason":"❌ QA FAIL: <step N failed — exact fix needed>"}` +
      apiRef
    );
  }

  // reviewer
  return (
    base +
    dod +
    `---\n` +
    `You are the **Reviewer**. QA has passed this task — perform final audit.\n\n` +
    `1. GET /tasks/${task.id} — read full task with all steps and their outputs\n` +
    `2. GET /tasks/${task.id}/notes — read executor + QA notes\n` +
    `3. GET /tasks/${task.id}/communications — read the full agent communication log\n` +
    `4. Audit EVERY step output against the Definition of Done\n` +
    `5. Log your review:\n` +
    `POST /tasks/${task.id}/communication {"agent":"${task.reviewer_agent ?? 'Sr Developer'}","msg_type":"thinking","content":"<your review reasoning>"}\n` +
    `POST /tasks/${task.id}/note {"agent":"${task.reviewer_agent ?? 'Sr Developer'}","stage":"review","note":"<review decision + rationale>"}\n\n` +
    `# If APPROVED:\n` +
    `PUT /tasks/${task.id} {"status":"completed","reviewed_at":"${new Date().toISOString()}"}\n\n` +
    `# If REJECTED:\n` +
    `PUT /tasks/${task.id} {"status":"rejected","rejected_reason":"🔴 REJECTED: <step N — specific fix required>"}` +
    apiRef
  );
}

async function fetchPipelineTasks(status: string): Promise<CmdCenterTask[]> {
  try {
    const res = await fetch(
      `${CMDCENTER_API_URL}/tasks?status=${status}&limit=50`,
      {
        headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      success: boolean;
      data: CmdCenterTask[];
    };
    return data.success && Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    logger.error({ err, status }, 'Failed to fetch tasks');
    return [];
  }
}

async function fetchPendingNanoclawTasks(): Promise<CmdCenterTask[]> {
  // Full pipeline: fetch all active stages
  const [pending, inProgress, executed, review] = await Promise.all([
    fetchPipelineTasks('pending'),
    fetchPipelineTasks('in_progress'),
    fetchPipelineTasks('executed'),
    fetchPipelineTasks('review'),
  ]);

  const allTasks = [...pending, ...inProgress, ...executed, ...review];

  // Deduplicate
  const seen = new Set<number>();
  const unique = allTasks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // Filter: at least one known agent must exist for this task's current stage
  return unique.filter((t) => {
    const { agentName } = resolveAgentForStage(t);
    return agentName && agentName in AGENT_TO_FOLDER;
  });
}
