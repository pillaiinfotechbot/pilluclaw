/**
 * WT-NC-07 — `type: ai-decision` action handler.
 *
 * Calls the OpenRouter integration's `chat()` method with templated system /
 * user prompts, extracts the FIRST top-level JSON object from the LLM
 * response, validates it against `def.output_schema` (JSON Schema, via Ajv),
 * and exposes the parsed object as `output.data`.
 */
import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import { ActionHandler } from '../action-registry.js';
import { setStepOutput, resolveTemplate } from '../workflow-engine-helpers.js';
import { logger } from '../logger.js';
import type { AiDecisionActionDef } from '../workflow-types.js';
import type { IntegrationRegistry } from '../integrations/registry.js';

// Ajv ships both `module.exports = Ajv` AND `module.exports.default = Ajv`.
// Under NodeNext + esModuleInterop, the default import sometimes binds to the
// CJS namespace itself (no construct signature). Resolve at runtime.
interface AjvLike {
  compile(schema: unknown): ValidateFunction;
}
type AjvCtorType = new (opts?: Record<string, unknown>) => AjvLike;
const AjvCtor: AjvCtorType =
  (AjvModule as unknown as { default?: AjvCtorType }).default ??
  (AjvModule as unknown as AjvCtorType);

export class AiDecisionAction implements ActionHandler {
  private validate: ValidateFunction;

  constructor(
    private readonly def: AiDecisionActionDef,
    private readonly integrations: IntegrationRegistry,
  ) {
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    this.validate = ajv.compile(def.output_schema);
  }

  name(): string {
    return this.def.name;
  }

  async execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.integrations.has(this.def.integration)) {
      throw new Error(
        `AiDecisionAction[${this.def.name}]: integration '${this.def.integration}' is not registered`,
      );
    }

    const tplCtx: Record<string, unknown> = { ...context, input: config };
    const system = resolveTemplate(this.def.system, tplCtx);
    const user = resolveTemplate(this.def.user, tplCtx);

    const callInput: Record<string, unknown> = {
      model: this.def.model,
      system,
      user,
      max_tokens: this.def.max_tokens,
      timeout_ms: this.def.timeout_ms,
    };
    if (this.def.temperature !== undefined) {
      callInput.temperature = this.def.temperature;
    }

    const result = (await this.integrations.call(
      this.def.integration,
      'chat',
      callInput,
    )) as { content?: string };

    const content = result?.content ?? '';
    const parsed = extractJsonObject(content);
    if (parsed === undefined) {
      throw new Error(
        `AiDecisionAction[${this.def.name}]: no JSON object found in LLM response`,
      );
    }

    if (!this.validate(parsed)) {
      logger.warn(
        { errors: this.validate.errors, action: this.def.name },
        'AiDecisionAction: output failed schema validation',
      );
      throw new Error(
        `AiDecisionAction[${this.def.name}]: output failed schema validation: ${JSON.stringify(this.validate.errors)}`,
      );
    }

    setStepOutput(context, { data: parsed });
  }
}

/**
 * Best-effort JSON extraction from an LLM completion. Tries strict parse
 * first, then a greedy `{...}` regex.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}
