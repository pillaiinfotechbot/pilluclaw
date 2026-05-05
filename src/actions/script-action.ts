/**
 * WT-NC-07 — `type: script` action handler.
 *
 * Runs a JS snippet in a Node `vm` sandbox. Globals exposed: `console`,
 * `JSON`, `Math`, `Date`, `URL`, `URLSearchParams`. NO `process`, `fs`,
 * `require`, or network — scripts are for pure transformation logic.
 */
import vm from 'vm';
import fs from 'fs';
import path from 'path';
import { ActionHandler } from '../action-registry.js';
import { setStepOutput } from '../workflow-engine-helpers.js';
import { logger } from '../logger.js';
import type { ScriptActionDef } from '../workflow-types.js';

export class ScriptAction implements ActionHandler {
  private readonly source: string;

  constructor(
    private readonly def: ScriptActionDef,
    /** Root dir under which `def.file` is resolved. */
    scriptsRoot: string = path.join(
      process.env.HOME || '~',
      '.config',
      'pilluclaw',
      'scripts',
    ),
  ) {
    if (def.code) {
      this.source = def.code;
    } else if (def.file) {
      const resolved = path.resolve(scriptsRoot, def.file);
      if (!fs.existsSync(resolved)) {
        throw new Error(
          `ScriptAction[${def.name}]: script file not found: ${resolved}`,
        );
      }
      this.source = fs.readFileSync(resolved, 'utf-8');
    } else {
      throw new Error(
        `ScriptAction[${def.name}]: one of 'code' or 'file' is required`,
      );
    }
  }

  name(): string {
    return this.def.name;
  }

  async execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const sandbox: Record<string, unknown> = {
      input: config,
      ctx: context,
      console: {
        log: (...a: unknown[]) => logger.debug({ a }, 'ScriptAction.log'),
      },
      JSON,
      Math,
      Date,
      URL,
      URLSearchParams,
    };

    let value: unknown;
    try {
      const wrapped = `(async () => { return (${this.source}); })()`;
      const ctx = vm.createContext(sandbox);
      const promise = vm.runInContext(wrapped, ctx, {
        timeout: this.def.timeout_ms,
      }) as Promise<unknown>;

      value = await Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `ScriptAction[${this.def.name}]: script timed out after ${this.def.timeout_ms}ms`,
                ),
              ),
            this.def.timeout_ms,
          ).unref(),
        ),
      ]);
    } catch (err) {
      logger.warn(
        { err, action: this.def.name },
        'ScriptAction: execution failed',
      );
      throw err;
    }

    setStepOutput(context, { data: value });
  }
}
