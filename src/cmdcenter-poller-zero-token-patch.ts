/**
 * cmdcenter-poller-zero-token-patch.ts
 * Task #898 — 0-Token Dispatch Detection Patch for NanoClaw cmdcenter-poller.ts
 *
 * INTEGRATION: After every call to dispatchTask(), call:
 *   scheduleZeroTokenCheck(taskId);
 *
 * INSERT POINT in cmdcenter-poller.ts:
 *   // After: await dispatchTask(task);
 *   scheduleZeroTokenCheck(task.id);
 */

const CMDCENTER_BASE = process.env.CMDCENTER_API_URL || 'https://cmdcenterapi.pillaiinfotech.com/api/v1';
const BOT_KEY = process.env.CMDCENTER_BOT_KEY || 'nc_bot_pillai2026';
const ZERO_TOKEN_CHECK_DELAY_MS = 30 * 60 * 1000; // 30 minutes

interface TaskResponse {
  id: number;
  status: string;
  tokens_in: number;
  tokens_out: number;
  thinking_log: string | null;
  title: string;
  assigned_agent: string;
}

/**
 * Schedule a 30-minute post-dispatch check for a task.
 * Called immediately after dispatchTask() in the poller loop.
 * Non-blocking — does not delay the dispatch cycle.
 */
export function scheduleZeroTokenCheck(taskId: number): void {
  setTimeout(async () => {
    await checkZeroTokenDispatch(taskId);
  }, ZERO_TOKEN_CHECK_DELAY_MS);
}

/**
 * Check if a dispatched task is a genuine Mode B stall.
 * Mode A (token tracking gap): thinking_log is populated — task ran, just no token write-back. NO alert.
 * Mode B (genuine stall): thinking_log is NULL, tokens=0, status=in_progress — alert required.
 */
async function checkZeroTokenDispatch(taskId: number): Promise<void> {
  try {
    const res = await fetch(`${CMDCENTER_BASE}/tasks/${taskId}`, {
      headers: { 'X-Bot-Key': BOT_KEY },
    });
    const json = await res.json() as { data: TaskResponse };
    const task: TaskResponse = json.data;

    // Not in progress anymore — task completed normally
    if (task.status !== 'in_progress') return;

    // Mode A: Claude ran, token write-back just failed. Not a stall.
    if (task.thinking_log !== null && task.thinking_log.trim() !== '') return;

    // Mode B: Genuine stall — tokens=0, thinking_log=NULL, still in_progress after 30min
    if (task.tokens_in === 0 && task.tokens_out === 0) {
      await fireZeroTokenAlert(task);
    }
  } catch (err) {
    console.error(`[ZeroTokenCheck] Error checking task ${taskId}:`, err);
  }
}

/**
 * Fire a CRITICAL alert for a genuine Mode B stall.
 * Creates a task assigned to CTO Agent + logs error communication on the stalled task.
 */
async function fireZeroTokenAlert(task: TaskResponse): Promise<void> {
  const alertTitle = `CRITICAL: 0-Token Stall Detected — Task #${task.id} (${task.assigned_agent})`;

  // Create alert task for CTO Agent
  await fetch(`${CMDCENTER_BASE}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Key': BOT_KEY,
    },
    body: JSON.stringify({
      title: alertTitle,
      description: `Genuine Mode B stall detected by zero-token poller check.\n\nTask #${task.id}: "${task.title}"\nAssigned agent: ${task.assigned_agent}\nStatus: in_progress with tokens_in=0, tokens_out=0, thinking_log=NULL after 30 minutes.\n\nAction required: investigate container/sysbridge status and re-queue if needed.`,
      assigned_agent: 'CTO Agent',
      priority: 'critical',
      project_id: 1,
    }),
  });

  // Log error communication on the stalled task itself
  await fetch(`${CMDCENTER_BASE}/tasks/${task.id}/communication`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Key': BOT_KEY,
    },
    body: JSON.stringify({
      agent: 'ZeroTokenPoller',
      msg_type: 'error',
      content: `STALL DETECTED: Task still shows 0 tokens and NULL thinking_log after 30 minutes in_progress. This is a Mode B genuine stall — container likely failed to invoke Claude. CTO Agent alerted.`,
    }),
  });

  console.error(`[ZeroTokenCheck] CRITICAL: Mode B stall on Task #${task.id} — CTO alerted`);
}
