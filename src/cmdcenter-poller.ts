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
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import {
  storeMessageDirect,
  storeChatMetadata,
  getAllRegisteredGroups,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { RegisteredGroup } from './types.js';
import { CONTAINER_PREFIX } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

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
  'CMDCenter API Agent': 'telegram_apiagent',
  APIAgent: 'telegram_apiagent',
  'API Agent': 'telegram_apiagent',
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
  telegram_apiagent: '/apiagent',
};

// ── Container concurrency limits ──────────────────────────────────────────────

/** Hard cap on total simultaneous nanoclaw containers (prevents Docker OOM). */
const MAX_CONCURRENT_CONTAINERS = Number(process.env.MAX_CONCURRENT_CONTAINERS ?? 8);

/** Max simultaneous containers per agent (prevents one agent monopolising capacity). */
const MAX_PER_AGENT = Number(process.env.MAX_CONTAINERS_PER_AGENT ?? 2);

/**
 * Count currently running nanoclaw containers (by prefix in docker ps output).
 * Returns { total, perAgent } — perAgent keyed by agent folder name.
 */
function countRunningContainers(): { total: number; perAgent: Map<string, number> } {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter "name=${CONTAINER_PREFIX}-" --format "{{.Names}}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
    );
    const names = output.trim().split('\n').filter(Boolean);
    const perAgent = new Map<string, number>();
    for (const name of names) {
      // Container name format: nanoclaw-telegram_cto_t821-<timestamp>
      // Extract folder slug between first dash and last dash-timestamp
      const match = name.match(/^[^-]+-(.+)-\d+$/);
      if (match) {
        const folder = match[1].replace(/-/g, '_');
        // Normalise task-specific folder (telegram_cto_t821 → telegram_cto)
        const baseFolder = folder.replace(/_t\d+$/, '');
        perAgent.set(baseFolder, (perAgent.get(baseFolder) ?? 0) + 1);
      }
    }
    return { total: names.length, perAgent };
  } catch {
    // If docker ps fails, be conservative — allow dispatch
    return { total: 0, perAgent: new Map() };
  }
}

// ── Injection cache ───────────────────────────────────────────────────────────

// Track which task IDs we've already injected, with injection timestamp.
// Persisted to disk so restarts don't cause duplicate container spawns (bug #157).
const INJECT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const INJECT_CACHE_PATH = path.join(
  process.env.HOME ?? '/tmp',
  '.nanoclaw-injected-tasks.json',
);

// Load persisted injection map from disk (survives restarts)
const injectedTaskIds = new Map<number, number>(); // taskId → injectedAt (ms)

function loadInjectedCache(): void {
  try {
    if (!fs.existsSync(INJECT_CACHE_PATH)) return;
    const raw = fs.readFileSync(INJECT_CACHE_PATH, 'utf8');
    const obj = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    for (const [id, ts] of Object.entries(obj)) {
      if (now - ts < INJECT_TTL_MS) {
        injectedTaskIds.set(Number(id), ts);
      }
    }
    logger.info(
      { loaded: injectedTaskIds.size },
      'CMDCenter poller: loaded injection cache from disk',
    );
  } catch {
    // ignore — fresh start is fine
  }
}

function saveInjectedCache(): void {
  try {
    const obj: Record<string, number> = {};
    for (const [id, ts] of injectedTaskIds.entries()) {
      obj[id] = ts;
    }
    fs.writeFileSync(INJECT_CACHE_PATH, JSON.stringify(obj), 'utf8');
  } catch {
    // non-fatal
  }
}

// Initialise from disk immediately
loadInjectedCache();

// Terminal statuses — never re-inject regardless of TTL
const TERMINAL_STATUSES = new Set([
  'passed',
  'in_testing',
  'completed',
  'rejected',
]);

// Statuses that only LiveTest should receive
const LIVETEST_ONLY_STATUSES = new Set(['completed']);

// ── Main poller ───────────────────────────────────────────────────────────────

// Callback type for dynamic group registration (injected from index.ts to avoid circular dep)
type RegisterGroupFn = (jid: string, group: RegisteredGroup) => void;
let _registerGroupFn: RegisterGroupFn | null = null;

export function startCmdCenterPoller(
  queue: GroupQueue,
  registerGroupFn?: RegisterGroupFn,
): void {
  if (registerGroupFn) _registerGroupFn = registerGroupFn;
  logger.info(
    { apiUrl: CMDCENTER_API_URL, intervalMs: POLL_INTERVAL_MS },
    'CMDCenter task poller started',
  );
  pollOnce(queue);
  setInterval(() => pollOnce(queue), POLL_INTERVAL_MS);
}

async function pollOnce(queue: GroupQueue): Promise<void> {
  // Clear per-cycle identity cache so stale data doesn't persist across polls
  agentIdentityCache.clear();
  try {
    const tasks = await fetchPendingNanoclawTasks();
    if (tasks.length === 0) return;

    const registeredGroups = getAllRegisteredGroups();

    // Build folder → base JID reverse lookup
    const folderToJid = new Map<string, string>();
    for (const [jid, groups] of Object.entries(registeredGroups)) {
      for (const group of groups) {
        folderToJid.set(group.folder, jid);
      }
    }

    // Sort tasks by weighted priority score — highest urgency first
    const sortedTasks = [...tasks].sort((a, b) => scoreTask(b) - scoreTask(a));

    // Snapshot running containers once per poll cycle (not per task)
    const { total: runningTotal, perAgent: runningPerAgent } = countRunningContainers();
    if (runningTotal >= MAX_CONCURRENT_CONTAINERS) {
      logger.warn(
        { runningTotal, limit: MAX_CONCURRENT_CONTAINERS },
        'CMDCenter poller: container limit reached — skipping dispatch this cycle',
      );
      return;
    }

    let injected = 0;
    // Track containers added this cycle so we don't exceed limit mid-loop
    let addedThisCycle = 0;
    const addedPerAgent = new Map<string, number>();

    for (const task of sortedTasks) {
      // ── Determine which agent handles this task at its current stage ──
      const { agentName, role } = resolveAgentForStage(task);
      if (!agentName) continue;

      const folder = AGENT_TO_FOLDER[agentName];
      if (!folder) continue;

      const baseJid = folderToJid.get(folder);
      if (!baseJid) {
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

      // ── Concurrency guard: stop if global or per-agent limit reached ────────
      const globalNow = runningTotal + addedThisCycle;
      if (globalNow >= MAX_CONCURRENT_CONTAINERS) {
        logger.warn(
          { globalNow, limit: MAX_CONCURRENT_CONTAINERS },
          'CMDCenter poller: global container limit reached mid-loop — stopping dispatch',
        );
        break;
      }
      const agentNow = (runningPerAgent.get(folder) ?? 0) + (addedPerAgent.get(folder) ?? 0);
      if (agentNow >= MAX_PER_AGENT) {
        logger.info(
          { folder, agentNow, limit: MAX_PER_AGENT, taskId: task.id },
          'CMDCenter poller: per-agent container limit reached — skipping task',
        );
        continue;
      }

      // ── Task-specific JID + folder for parallel container isolation ────────
      // Each task gets its own unique JID so tasks run in parallel containers
      // rather than queuing serially behind a shared virtual:cto JID.
      // JID format:  virtual:cto:task-821  (VirtualChannel owns all virtual:* JIDs)
      // Folder format: telegram_cto_t821   (must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)
      const taskJid = `${baseJid}:task-${task.id}`;
      const taskFolder = `${folder}_t${task.id}`;

      // Dynamically register the task-specific group so processGroupMessages
      // can find it in registeredGroups[taskJid]. Copy CLAUDE.md from base folder.
      if (_registerGroupFn) {
        const baseGroupDir = resolveGroupFolderPath(folder);
        const taskGroupDir = resolveGroupFolderPath(taskFolder);
        // Ensure task folder exists with logs subdir
        fs.mkdirSync(path.join(taskGroupDir, 'logs'), { recursive: true });
        // Copy CLAUDE.md from base folder if not already present
        const baseMd = path.join(baseGroupDir, 'CLAUDE.md');
        const taskMd = path.join(taskGroupDir, 'CLAUDE.md');
        if (!fs.existsSync(taskMd) && fs.existsSync(baseMd)) {
          fs.copyFileSync(baseMd, taskMd);
        }
        // Register in DB and in-memory registeredGroups
        // requiresTrigger must be false — the poller injects the message directly
        // (task prompt doesn't start with a trigger word) so the trigger check
        // in processGroupMessages would silently skip it if requiresTrigger: true.
        const taskGroup: RegisteredGroup = {
          name: `${agentName} Task #${task.id}`,
          folder: taskFolder,
          trigger: FOLDER_TO_TRIGGER[folder] ?? '/cmd',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
        _registerGroupFn(taskJid, taskGroup);
      }

      const trigger = FOLDER_TO_TRIGGER[folder] ?? '/cmd';
      const priority = (task.priority ?? 'medium').toUpperCase();
      // Fetch agent identity from CMDCenter for prompt enrichment (best-effort)
      const identity = await fetchAgentIdentity(agentName);
      const content = buildTaskPrompt(trigger, priority, task, role, identity);

      storeChatMetadata(taskJid, new Date().toISOString());
      storeMessageDirect({
        id: `cmdcenter-task-${task.id}-${randomUUID()}`,
        chat_jid: taskJid,
        sender: 'cmdcenter-poller',
        sender_name: 'CMDCenter',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: false,
      });

      queue.enqueueMessageCheck(taskJid);
      injectedTaskIds.set(task.id, Date.now());
      saveInjectedCache(); // persist immediately so restarts don't re-inject (bug #157)
      injected++;
      addedThisCycle++;
      addedPerAgent.set(folder, (addedPerAgent.get(folder) ?? 0) + 1);

      logger.info(
        {
          taskId: task.id,
          agentName,
          role,
          folder,
          baseJid,
          taskJid,
          taskFolder,
        },
        'CMDCenter poller: injected task (parallel container)',
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
  identity?: AgentIdentity | null,
): string {
  // ── Agent identity preamble (fetched from CMDCenter DB) ───────────────────
  // Provides agent with full context of who they are — no CLAUDE.md needed.
  let identityBlock = '';
  if (identity) {
    identityBlock += `## Your Identity\n`;
    identityBlock += `**Name:** ${identity.name}\n`;
    if (identity.role) identityBlock += `**Role:** ${identity.role}\n`;
    if (identity.calling) identityBlock += `**Calling:** ${identity.calling}\n`;
    if (identity.backstory)
      identityBlock += `**Backstory:** ${identity.backstory}\n`;
    identityBlock += '\n';
    if (identity.memory.length > 0) {
      identityBlock += `## Your Memory\n`;
      for (const item of identity.memory) {
        identityBlock += `- ${item}\n`;
      }
      identityBlock += '\n';
    }
  }

  // ── Model usage note ──────────────────────────────────────────────────────
  // Containers use CLAUDE_CODE_OAUTH_TOKEN which maps to claude-sonnet-4-6.
  // Do NOT call OpenRouter or external AI APIs — use default Claude model.
  const modelNote =
    `> **Model:** Use your default Claude model (claude-sonnet-4-6 via OAuth). ` +
    `Do NOT use OpenRouter or external AI APIs unless the task explicitly requires ` +
    `a non-Claude capability (image generation, video, etc.).\n\n`;

  const base =
    identityBlock +
    modelNote +
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

  const executorName = task.assigned_agent ?? 'Agent';
  const qaName = task.qa_agent ?? 'QA Agent';
  const reviewerName = task.reviewer_agent ?? 'Sr Developer';

  if (role === 'executor') {
    return (
      base +
      dod +
      `---\n` +
      `You are **${executorName}** — the Executor for this task.\n\n` +
      `## Step 0 — Read the task\n` +
      `GET /tasks/${task.id}\n` +
      `Read the full task. Check the \`steps\` array.\n\n` +
      `## If \`steps\` array is EMPTY — define steps first\n` +
      `Before doing any work, create ALL steps for the full pipeline: your implementation steps AND\n` +
      `QA test steps (assigned_agent: "${task.qa_agent ?? 'QA Agent'}") AND reviewer steps (assigned_agent: "${task.reviewer_agent ?? 'Sr Developer'}").\n\n` +
      `For each step call:\n` +
      `POST /steps\n` +
      `{"task_id":${task.id},"title":"<step title>","description":"<what to do>","assigned_agent":"<agent name>","step_number":<N>}\n\n` +
      `Example for "Create Login Form":\n` +
      `  step 1: "Create HTML form file" → assigned_agent: "${executorName}"\n` +
      `  step 2: "Add form fields and validation" → assigned_agent: "${executorName}"\n` +
      `  step 3: "Integrate /auth/login API call" → assigned_agent: "${executorName}"\n` +
      `  step 4: "Confirm API responds correctly" → assigned_agent: "${task.qa_agent ?? 'QA Agent'}"\n` +
      `  step 5: "Confirm form loads without errors" → assigned_agent: "${task.qa_agent ?? 'QA Agent'}"\n` +
      `  step 6: "Review code standards and layout" → assigned_agent: "${task.reviewer_agent ?? 'Sr Developer'}"\n\n` +
      `## If \`steps\` array already has steps — skip Step 0 above\n` +
      `Work ONLY through steps where \`assigned_agent == "${executorName}"\`.\n` +
      `Do NOT touch steps assigned to other agents (QA, Reviewer, etc.).\n\n` +
      `## For each of YOUR steps, in order:\n` +
      `1. PUT /steps/<step_id>  → {"status":"in_progress","assigned_agent":"${executorName}"}\n` +
      `2. Mark task in progress: PUT /tasks/${task.id} → {"status":"in_progress"}\n` +
      `3. Do the actual work described in the step\n` +
      `4. POST /tasks/${task.id}/communication → {"agent":"${executorName}","msg_type":"thinking","step_id":<id>,"content":"<what you are doing and why>"}\n` +
      `5. PUT /steps/<step_id>  → {"status":"completed","output":"<result>","cost":<USD>,"tokens_in":<N>,"tokens_out":<N>,"model_used":"<model>","duration_ms":<ms>}\n` +
      `6. POST /tasks/${task.id}/communication → {"agent":"${executorName}","msg_type":"note","step_id":<id>,"content":"Done: <what was done, why this satisfies the step>"}\n\n` +
      `## After ALL your steps are complete:\n` +
      `POST /tasks/${task.id}/note → {"agent":"${executorName}","stage":"executed","note":"<summary: what was built, how it meets the Definition of Done>"}\n` +
      `PUT /tasks/${task.id}      → {"status":"executed","thinking_log":"<detailed result>"}` +
      apiRef
    );
  }

  if (role === 'qa') {
    return (
      base +
      dod +
      `---\n` +
      `You are **${qaName}** — the QA Agent for this task.\n\n` +
      `## Your job\n` +
      `GET /tasks/${task.id} — read the full task. The \`steps\` array contains every step.\n` +
      `You have TWO responsibilities:\n` +
      `A. Verify the Executor's completed steps against the Definition of Done\n` +
      `B. Execute steps where \`assigned_agent == "${qaName}"\` (your QA test steps)\n\n` +
      `## For each QA test step assigned to you:\n` +
      `1. PUT /steps/<step_id>  → {"status":"in_progress","assigned_agent":"${qaName}"}\n` +
      `2. Run the test / validation described in the step\n` +
      `3. POST /tasks/${task.id}/communication → {"agent":"${qaName}","msg_type":"note","step_id":<id>,"content":"Test: <what was tested> Result: PASS/FAIL — <reason>"}\n` +
      `4. PUT /steps/<step_id>  → {"status":"completed|failed","output":"<test result details>"}\n\n` +
      `## After all QA steps:\n` +
      `POST /tasks/${task.id}/note → {"agent":"${qaName}","stage":"qa_check","note":"QA Summary: <what was tested, which passed, which failed>"}\n\n` +
      `# If ALL tests PASS:\n` +
      `PUT /tasks/${task.id} → {"status":"review","thinking_log":"✅ QA PASS: <summary>"}\n\n` +
      `# If ANY test FAILS:\n` +
      `PUT /tasks/${task.id} → {"status":"pending","rejected_reason":"❌ QA FAIL: Step <N> — <exact failure and what executor must fix>"}` +
      apiRef
    );
  }

  // reviewer
  return (
    base +
    dod +
    `---\n` +
    `You are **${reviewerName}** — the Reviewer for this task.\n\n` +
    `## Your job\n` +
    `GET /tasks/${task.id} — read the full task with all steps and their outputs.\n` +
    `GET /tasks/${task.id}/notes — read executor and QA notes.\n` +
    `GET /tasks/${task.id}/communications — read the full agent exchange log.\n\n` +
    `You have TWO responsibilities:\n` +
    `A. Audit that the Definition of Done is fully satisfied by the executor's work\n` +
    `B. Execute steps where \`assigned_agent == "${reviewerName}"\` (your review steps)\n\n` +
    `## For each review step assigned to you:\n` +
    `1. PUT /steps/<step_id>  → {"status":"in_progress","assigned_agent":"${reviewerName}"}\n` +
    `2. Perform the review check described in the step\n` +
    `3. POST /tasks/${task.id}/communication → {"agent":"${reviewerName}","msg_type":"thinking","step_id":<id>,"content":"<review reasoning and findings>"}\n` +
    `4. PUT /steps/<step_id>  → {"status":"completed|failed","output":"<review result>"}\n\n` +
    `## Final decision:\n` +
    `POST /tasks/${task.id}/note → {"agent":"${reviewerName}","stage":"review","note":"<full review: what was audited, DoD met? yes/no, any gaps>"}\n\n` +
    `# If APPROVED — all review steps pass and DoD is met:\n` +
    `PUT /tasks/${task.id} → {"status":"completed","reviewed_at":"${new Date().toISOString()}"}\n\n` +
    `# If REJECTED — DoD not met or review step failed:\n` +
    `PUT /tasks/${task.id} → {"status":"rejected","rejected_reason":"🔴 REJECTED by ${reviewerName}: <step N — exact issue and what must be fixed>"}` +
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

// ── Agent Identity (fetched from CMDCenter DB at injection time) ───────────────

interface AgentIdentity {
  name: string;
  role: string | null;
  calling: string | null;
  backstory: string | null;
  memory: string[];
}

// Cache agent identities for the duration of a single poll cycle (avoids
// redundant API calls when multiple tasks share the same agent).
const agentIdentityCache = new Map<string, AgentIdentity>();

async function fetchAgentIdentity(
  agentName: string,
): Promise<AgentIdentity | null> {
  if (agentIdentityCache.has(agentName))
    return agentIdentityCache.get(agentName)!;

  try {
    // Fetch agent record by name
    const agentRes = await fetch(
      `${CMDCENTER_API_URL}/agents/${encodeURIComponent(agentName)}`,
      {
        headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!agentRes.ok) return null;
    const agentData = (await agentRes.json()) as {
      success: boolean;
      data: {
        id?: number;
        name?: string;
        role?: string | null;
        calling?: string | null;
        backstory?: string | null;
      };
    };
    if (!agentData.success || !agentData.data) return null;

    const agent = agentData.data;
    const memory: string[] = [];

    // Fetch agent memory items if agent has an id
    if (agent.id) {
      try {
        const memRes = await fetch(
          `${CMDCENTER_API_URL}/agent-memory?agent_id=${agent.id}&limit=20`,
          {
            headers: { 'X-Bot-Key': CMDCENTER_BOT_KEY },
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (memRes.ok) {
          const memData = (await memRes.json()) as {
            success: boolean;
            data: Array<{
              memory_key?: string;
              memory_value?: string;
              content?: string;
            }>;
          };
          if (memData.success && Array.isArray(memData.data)) {
            for (const item of memData.data) {
              const key = item.memory_key ?? '';
              const val = item.memory_value ?? item.content ?? '';
              if (val) memory.push(key ? `**${key}:** ${val}` : val);
            }
          }
        }
      } catch {
        // Memory fetch failing is non-fatal
      }
    }

    const identity: AgentIdentity = {
      name: agent.name ?? agentName,
      role: agent.role ?? null,
      calling: agent.calling ?? null,
      backstory: agent.backstory ?? null,
      memory,
    };
    agentIdentityCache.set(agentName, identity);
    return identity;
  } catch {
    return null;
  }
}
