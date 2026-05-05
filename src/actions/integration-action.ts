/**
 * WT-NC-07 — `type: integration` action handler.
 *
 * Looks up `def.integration` in the IntegrationRegistry and calls
 * `def.method` with the resolved input. The return value is wrapped as
 * `{ data: <returnValue> }` and exposed to the workflow run.
 */
import { ActionHandler } from '../action-registry.js';
import { setStepOutput } from '../workflow-engine-helpers.js';
import { logger } from '../logger.js';
import type { IntegrationActionDef } from '../workflow-types.js';
import type { IntegrationRegistry } from '../integrations/registry.js';

export class IntegrationAction implements ActionHandler {
  constructor(
    private readonly def: IntegrationActionDef,
    private readonly integrations: IntegrationRegistry,
  ) {}

  name(): string {
    return this.def.name;
  }

  async execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.integrations.has(this.def.integration)) {
      throw new Error(
        `IntegrationAction[${this.def.name}]: integration '${this.def.integration}' is not registered`,
      );
    }

    const call = this.integrations.call(
      this.def.integration,
      this.def.method,
      config,
    );

    let result: unknown;
    try {
      result = await Promise.race([
        call,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `IntegrationAction[${this.def.name}]: timed out after ${this.def.timeout_ms}ms`,
                ),
              ),
            this.def.timeout_ms,
          ).unref(),
        ),
      ]);
    } catch (err) {
      logger.warn({ err, action: this.def.name }, 'IntegrationAction: failed');
      throw err;
    }

    setStepOutput(context, { data: result });
  }
}
