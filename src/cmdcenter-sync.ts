/**
 * CMDCenter Agent Status Sync
 *
 * Reports agent status (active/idle) and current task to CMDCenter
 * in real-time as containers start and stop. This gives CMDCenter
 * live visibility into what pilluclaw is executing.
 *
 * Called from index.ts before/after runContainerAgent.
 */

import { logger } from './logger.js';

const CMDCENTER_API_URL =
  process.env.CMDCENTER_API_URL ??
  'https://cmdcenterapi.pillaiinfotech.com/api/v1';
const CMDCENTER_BOT_KEY = process.env.CMDCENTER_BOT_KEY ?? 'nc_bot_pillai2026';

// Map group folder → CMDCenter agent name
const FOLDER_TO_AGENT: Record<string, string> = {
  telegram_ceo:          'CEO Agent',
  telegram_coo:          'COO Agent',
  telegram_cto:          'CTO Agent',
  telegram_cmo:          'CMO Agent',
  telegram_cfo:          'CFO Agent',
  telegram_chro:         'CHRO Agent',
  telegram_devbot:       'Dev Agent',
  telegram_qabot:        'QA Agent',
  telegram_pmbot:        'PM Agent',
  telegram_architectbot: 'Architect Agent',
  telegram_localaibot:   'LocalAIBot',
  telegram_cmdcenter:    'CMDCenter DevBot',
  telegram_agentbuilder: 'Agent Builder',
  telegram_srdev:        'Sr Developer',
  telegram_sysagent:     'SYSAgent',
};

async function patchAgent(
  agentName: string,
  payload: Record<string, string | null>,
): Promise<void> {
  try {
    const res = await fetch(`${CMDCENTER_API_URL}/agents/${encodeURIComponent(agentName)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Key': CMDCENTER_BOT_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.warn(
        { agentName, status: res.status },
        'CMDCenter sync: failed to patch agent',
      );
    }
  } catch (err) {
    logger.warn({ agentName, err }, 'CMDCenter sync: patch error (non-fatal)');
  }
}

/**
 * Call when a container starts running for an agent.
 * Sets status=active, last_active=now, current_task=taskTitle.
 */
export async function reportAgentActive(
  folder: string,
  currentTask?: string,
): Promise<void> {
  const agentName = FOLDER_TO_AGENT[folder];
  if (!agentName) return; // not a CMDCenter agent folder

  await patchAgent(agentName, {
    status: 'active',
    last_active: new Date().toISOString().slice(0, 19).replace('T', ' '),
    current_task: currentTask ?? null,
  });

  logger.info({ agentName, currentTask }, 'CMDCenter sync: agent set active');
}

/**
 * Call when a container finishes (success or error).
 * Sets status=idle, last_active=now, clears current_task.
 */
export async function reportAgentIdle(folder: string): Promise<void> {
  const agentName = FOLDER_TO_AGENT[folder];
  if (!agentName) return;

  await patchAgent(agentName, {
    status: 'idle',
    last_active: new Date().toISOString().slice(0, 19).replace('T', ' '),
    current_task: null,
  });

  logger.info({ agentName }, 'CMDCenter sync: agent set idle');
}
