/**
 * workflow-runtime.ts
 *
 * WHO:  pilluclaw — the workflow execution engine
 * WHY:  CMDCenter fires events → queues workflow runs → pilluclaw executes them
 * WHAT: Poll CMDCenter API, claim runs, parse YAML, execute steps as Tools, report back
 * HOW:  30s polling loop, REST API only (X-Bot-Key), concurrent run execution
 *
 * Communication: REST API only. No direct DB access.
 */

import yaml from 'yaml';
import { logger } from './logger.js';
import { ActionRegistry } from './action-registry.js';
import { WorkflowSchema, type WorkflowStep } from './workflow-schema.js';
import { evaluateExpression } from './workflow-expression.js';
import { resolveValue } from './workflow-engine-helpers.js';

const API_URL = process.env.CMDCENTER_API_URL ?? 'https://cmdcenterapi.pillaiinfotech.com/api/v1';
const BOT_KEY = process.env.CMDCENTER_BOT_KEY ?? 'nc_bot_pillai2026';
const POLL_MS = 30_000;

// ── Duration string parser ────────────────────────────────────────────────────

/** Parse a human duration string like `2h`, `30m`, `45s`, `500ms` to milliseconds. */
function parseDurationMs(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) return 1_000; // fallback 1s for unrecognised formats
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case 'ms': return n;
    case 's':  return n * 1_000;
    case 'm':  return n * 60_000;
    case 'h':  return n * 3_600_000;
    case 'd':  return n * 86_400_000;
    default:   return 1_000;
  }
}

// ── API helpers — REST only ──────────────────────────────────────────────────

function botHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Bot-Key': BOT_KEY };
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: botHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: botHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: botHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingRun {
  id: number;
  workflow_id: number;
  event_type: string;
  event_payload: string | null;
  workflow_name: string;
}

interface StepCtx {
  runId: number;
  event: Record<string, unknown>;
  steps: Record<string, unknown>; // step_id → output
}

// ── Step execution ───────────────────────────────────────────────────────────

async function executeStep(
  step: WorkflowStep,
  ctx: StepCtx,
  registry: ActionRegistry,
): Promise<unknown> {
  const t0 = Date.now();

  const rawInput = ('input' in step ? step.input : {}) as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawInput)) {
    input[k] = resolveValue(v, { event: ctx.event, steps: ctx.steps });
  }

  const execCtx = { event: ctx.event, steps: ctx.steps };

  try {
    let output: unknown = null;

    if (step.type === 'action') {
      const handler = registry.get(step.action);
      if (!handler) {
        throw new Error(
          `Unknown action "${step.action}". Registered: ${registry.listNames().join(', ')}`,
        );
      }
      await handler.execute(input, execCtx);
      output = input;

    } else if (step.type === 'condition') {
      const result = evaluateExpression(step.expr, execCtx);
      output = { result, branch: result ? 'true' : 'false' };

    } else if (step.type === 'delay') {
      const ms = step.duration ? parseDurationMs(step.duration) : 1_000;
      if (ms <= 60_000) await new Promise((r) => setTimeout(r, ms));
      output = { waited_ms: ms };

    } else {
      logger.warn({ type: step.type, id: step.id }, 'workflow-runtime: unsupported step type — skipping');
      await apiPost(`/workflow-runtime/runs/${ctx.runId}/steps`, {
        step_key: step.id,
        action_type: step.type,
        status: 'skipped',
        output: { reason: 'unsupported_step_type' },
        duration_ms: 0,
      });
      return null;
    }

    await apiPost(`/workflow-runtime/runs/${ctx.runId}/steps`, {
      step_key: step.id,
      action_type: step.type,
      status: 'success',
      input,
      output,
      duration_ms: Date.now() - t0,
    });
    return output;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await apiPost(`/workflow-runtime/runs/${ctx.runId}/steps`, {
      step_key: step.id,
      action_type: step.type,
      status: 'failed',
      error: msg,
      duration_ms: Date.now() - t0,
    }).catch(() => {});
    throw err;
  }
}

// ── Run execution ────────────────────────────────────────────────────────────

async function executeRun(run: PendingRun, registry: ActionRegistry): Promise<void> {
  logger.info({ runId: run.id, workflow: run.workflow_name }, 'workflow-runtime: run started');

  try {
    const def = await apiGet<{ definition: string; format: string }>(
      `/workflow-runtime/workflows/${run.workflow_id}/definition`,
    );

    const raw = def.format === 'json' ? JSON.parse(def.definition) : yaml.parse(def.definition);
    const parsed = WorkflowSchema.safeParse(raw);

    if (!parsed.success) {
      const errMsg = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      await apiPut(`/workflow-runtime/runs/${run.id}`, { status: 'failed', error: errMsg });
      logger.error({ runId: run.id, errMsg }, 'workflow-runtime: invalid definition');
      return;
    }

    const ctx: StepCtx = {
      runId: run.id,
      event: run.event_payload
        ? (JSON.parse(run.event_payload) as Record<string, unknown>)
        : {},
      steps: {},
    };

    for (const step of parsed.data.steps) {
      const output = await executeStep(step, ctx, registry);
      ctx.steps[step.id] = output;
    }

    await apiPut(`/workflow-runtime/runs/${run.id}`, { status: 'completed' });
    logger.info(
      { runId: run.id, steps: parsed.data.steps.length },
      'workflow-runtime: run completed',
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await apiPut(`/workflow-runtime/runs/${run.id}`, { status: 'failed', error: msg }).catch(
      () => {},
    );
    logger.error({ runId: run.id, err }, 'workflow-runtime: run failed');
  }
}

// ── Polling loop ─────────────────────────────────────────────────────────────

export function startWorkflowRuntime(registry: ActionRegistry): void {
  logger.info('workflow-runtime: starting (30s poll interval)');

  async function poll(): Promise<void> {
    try {
      const { runs = [] } = await apiGet<{ runs: PendingRun[] }>(
        '/workflow-runtime/runs/pending',
      );

      for (const run of runs) {
        try {
          await apiPost(`/workflow-runtime/runs/${run.id}/claim`, {});
        } catch {
          // Another instance claimed it first — skip
          continue;
        }
        // Fire-and-forget: run concurrently without blocking poll loop
        executeRun(run, registry).catch(() => {});
      }
    } catch (err) {
      logger.warn({ err }, 'workflow-runtime: poll error (will retry in 30s)');
    }
  }

  poll();
  setInterval(poll, POLL_MS);
}
