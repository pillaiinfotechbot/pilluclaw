/**
 * Inline type definitions for workflow action types.
 * Replaces nanoclaw's config-schema.ts — pilluclaw has no config-schema.
 */
import { z } from 'zod';

const RetryPolicySchema = z.object({
  max: z.number().int().nonnegative().default(0),
  backoff_ms: z.number().int().nonnegative().default(0),
});

export const ScriptActionDefSchema = z.object({
  name: z.string().min(1),
  type: z.literal('script'),
  description: z.string().optional(),
  code: z.string().optional(),
  file: z.string().optional(),
  timeout_ms: z.number().int().positive().default(30000),
});

export const HttpActionDefSchema = z.object({
  name: z.string().min(1),
  type: z.literal('http'),
  description: z.string().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  timeout_ms: z.number().int().positive().default(10000),
  retry: RetryPolicySchema.default({ max: 0, backoff_ms: 0 }),
  output_path: z.string().optional(),
});

export const IntegrationActionDefSchema = z.object({
  name: z.string().min(1),
  type: z.literal('integration'),
  description: z.string().optional(),
  integration: z.string().min(1),
  method: z.string().min(1),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().positive().default(15000),
});

export const AiDecisionActionDefSchema = z.object({
  name: z.string().min(1),
  type: z.literal('ai-decision'),
  description: z.string().optional(),
  integration: z.string().default('openrouter'),
  model: z.string().min(1),
  system: z.string().min(1),
  user: z.string().min(1),
  max_tokens: z.number().int().positive().default(500),
  temperature: z.number().nonnegative().optional(),
  output_schema: z.record(z.string(), z.unknown()),
  timeout_ms: z.number().int().positive().default(30000),
});

export const ActionDefinitionSchema = z.discriminatedUnion('type', [
  ScriptActionDefSchema,
  HttpActionDefSchema,
  IntegrationActionDefSchema,
  AiDecisionActionDefSchema,
]);

export type ScriptActionDef = z.infer<typeof ScriptActionDefSchema>;
export type HttpActionDef = z.infer<typeof HttpActionDefSchema>;
export type IntegrationActionDef = z.infer<typeof IntegrationActionDefSchema>;
export type AiDecisionActionDef = z.infer<typeof AiDecisionActionDefSchema>;
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;
