/**
 * Workflow YAML schema (Zod).
 *
 * WT-NC-05 landed the linear `action` runtime; WT-NC-06 fills in the runtimes
 * for branch / parallel / loop-for-each / sub-workflow / condition / delay /
 * ai-decision / error-handlers.
 *
 * Hand-written JSON Schema mirror lives at config/schemas/workflow.schema.json
 * (zod-to-json-schema is not installed in this project).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Top-level scheduling class
// ---------------------------------------------------------------------------

export const WorkflowClassSchema = z.enum([
  'hot-path',
  'immediate',
  'scheduled-overnight',
  'cron-batch',
]);

export type WorkflowClass = z.infer<typeof WorkflowClassSchema>;

// ---------------------------------------------------------------------------
// Triggers — what causes a workflow run to start
// ---------------------------------------------------------------------------

export const WorkflowTriggerSchema = z.object({
  event: z.string().optional(),
  cron: z.string().optional(),
  conditions: z.string().optional(),
});

export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

// ---------------------------------------------------------------------------
// Step types — discriminated union on `type`
// ---------------------------------------------------------------------------

const StepBase = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
});

/** Action step — invokes an action via the ActionRegistry. */
export const ActionStepSchema = StepBase.extend({
  type: z.literal('action'),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Branch step — N-way split on an expression. Each `cases.<key>` is a list of
 * child steps that run as a sub-sequence; `default` runs if no case matches.
 *
 * The legacy WT-NC-05 shape (`on: <name>`, `cases: {key: unknown}`) is still
 * accepted by the validator (`cases` values are loose `unknown` arrays); the
 * runner re-parses children via WorkflowStepSchema at execution time.
 */
export const BranchStepSchema = StepBase.extend({
  type: z.literal('branch'),
  on: z.string().min(1),
  cases: z.record(z.string(), z.array(z.unknown())).default({}),
  default: z.array(z.unknown()).optional(),
  next: z.string().optional(),
});

/** Parallel step — children run concurrently, joined per `join_mode`. */
export const ParallelStepSchema = StepBase.extend({
  type: z.literal('parallel'),
  join_mode: z.enum(['all', 'any', 'race']).default('all'),
  children: z.array(z.unknown()).default([]),
  next: z.string().optional(),
});

/** Loop-for-each — iterate `list` (array path), bind each item to `item_var`. */
export const LoopForEachStepSchema = StepBase.extend({
  type: z.literal('loop-for-each'),
  list: z.string().min(1),
  item_var: z.string().min(1).default('item'),
  max_iterations: z.number().int().positive().default(100),
  parallel: z.boolean().default(false),
  children: z.array(z.unknown()).default([]),
  next: z.string().optional(),
});

/** Sub-workflow — invoke another workflow by id. */
export const SubWorkflowStepSchema = StepBase.extend({
  type: z.literal('sub-workflow'),
  workflow_id: z.string().min(1),
  input_map: z.record(z.string(), z.unknown()).default({}),
  wait: z.boolean().default(true),
  next: z.string().optional(),
});

/**
 * Condition — predicate gate. On true → next_on_true, on false → next_on_false.
 * If neither is set, falls through to the next sibling.
 */
export const ConditionStepSchema = StepBase.extend({
  type: z.literal('condition'),
  expr: z.string().min(1),
  next_on_true: z.string().optional(),
  next_on_false: z.string().optional(),
});

/**
 * Delay — wait for a duration / cron / 'until' phrase.
 *
 * `duration` (eg `2h`, `30m`, `45s`, `500ms`): in-process `setTimeout`.
 * `schedule` (cron): persists the run as `queued` with `resume_at` set to the
 *   next cron fire time and exits — the resume loop picks it up.
 * `until` (free-form): the engine parses an ISO timestamp / `after HH:MM TZ`
 *   shape; otherwise persists as queued without a deadline (manual resume).
 */
export const DelayStepSchema = StepBase.extend({
  type: z.literal('delay'),
  duration: z.string().optional(),
  schedule: z.string().optional(),
  until: z.string().optional(),
  next: z.string().optional(),
});

/**
 * AI-decision — calls an action whose registered name typically starts with
 * `ai-decision.` (or any name — the registry decides). Output is validated
 * against `output_schema` (JSON Schema) via Ajv before being captured.
 */
export const AiDecisionStepSchema = StepBase.extend({
  type: z.literal('ai-decision'),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  next: z.string().optional(),
});

/** Error-handler step — runs on any in-scope failure. */
export const ErrorHandlerStepSchema = StepBase.extend({
  type: z.literal('error-handler'),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

export const WorkflowStepSchema = z.discriminatedUnion('type', [
  ActionStepSchema,
  BranchStepSchema,
  ParallelStepSchema,
  LoopForEachStepSchema,
  SubWorkflowStepSchema,
  ConditionStepSchema,
  DelayStepSchema,
  AiDecisionStepSchema,
  ErrorHandlerStepSchema,
]);

export type ActionStep = z.infer<typeof ActionStepSchema>;
export type BranchStep = z.infer<typeof BranchStepSchema>;
export type ParallelStep = z.infer<typeof ParallelStepSchema>;
export type LoopForEachStep = z.infer<typeof LoopForEachStepSchema>;
export type SubWorkflowStep = z.infer<typeof SubWorkflowStepSchema>;
export type ConditionStep = z.infer<typeof ConditionStepSchema>;
export type DelayStep = z.infer<typeof DelayStepSchema>;
export type AiDecisionStep = z.infer<typeof AiDecisionStepSchema>;
export type ErrorHandlerStep = z.infer<typeof ErrorHandlerStepSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

// ---------------------------------------------------------------------------
// Workflow-level error handlers (catch + redirect)
//
// Distinct from the legacy `error_handler: WorkflowStep[]` field which runs a
// fixed sequence after a failure. `error_handlers` defines pattern → next
// jumps that the engine consults before declaring the run failed.
// ---------------------------------------------------------------------------

export const WorkflowErrorHandlerSchema = z.object({
  catch: z.string().default('*'),
  next: z.string().min(1),
});

export type WorkflowErrorHandler = z.infer<typeof WorkflowErrorHandlerSchema>;

// ---------------------------------------------------------------------------
// Top-level Workflow schema
// ---------------------------------------------------------------------------

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  class: WorkflowClassSchema.default('immediate'),
  tenant: z.string().optional(),
  triggers: z.array(WorkflowTriggerSchema).default([]),
  inputs: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(WorkflowStepSchema).default([]),
  /** Legacy: linear sequence of steps to run after a failure (WT-NC-05). */
  error_handler: z.array(WorkflowStepSchema).optional(),
  /** WT-NC-06: pattern-based catch-and-redirect handlers. */
  error_handlers: z.array(WorkflowErrorHandlerSchema).optional(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
