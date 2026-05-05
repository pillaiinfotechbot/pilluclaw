import { logger } from './logger.js';
import type { ActionDefinition } from './workflow-types.js';
import type { IntegrationRegistry } from './integrations/registry.js';

export interface ActionHandler {
  name(): string;
  execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * WT-NC-07 — Optional dependencies the registry can hold so that YAML-loaded
 * action definitions (script/http/integration/ai-decision) can be turned into
 * handlers without the loader having to thread these everywhere.
 */
export interface ActionRegistryDeps {
  integrations?: IntegrationRegistry;
  /** Filesystem root for `type: script` actions that load from `file:`. */
  scriptsRoot?: string;
}

export class ActionRegistry {
  private handlers: Map<string, ActionHandler> = new Map();
  private deps: ActionRegistryDeps = {};

  /** Inject shared deps used when materialising YAML action definitions. */
  configure(deps: ActionRegistryDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** Register a pre-built handler instance. Used by builtin actions. */
  register(handler: ActionHandler): void {
    this.handlers.set(handler.name(), handler);
    logger.debug(
      { action: handler.name() },
      'ActionRegistry: registered (builtin)',
    );
  }

  /**
   * Register a typed action loaded from YAML. The registry materialises the
   * right handler subclass (`ScriptAction`, `HttpAction`, `IntegrationAction`,
   * `AiDecisionAction`) based on `def.type`.
   */
  async registerFromDefinition(def: ActionDefinition): Promise<void> {
    let handler: ActionHandler;
    switch (def.type) {
      case 'script': {
        const { ScriptAction } = await import('./actions/script-action.js');
        handler = new ScriptAction(def, this.deps.scriptsRoot);
        break;
      }
      case 'http': {
        const { HttpAction } = await import('./actions/http-action.js');
        handler = new HttpAction(def);
        break;
      }
      case 'integration': {
        if (!this.deps.integrations) {
          throw new Error(
            `ActionRegistry: integration action '${def.name}' requires an IntegrationRegistry — call configure({ integrations }) first`,
          );
        }
        const { IntegrationAction } =
          await import('./actions/integration-action.js');
        handler = new IntegrationAction(def, this.deps.integrations);
        break;
      }
      case 'ai-decision': {
        if (!this.deps.integrations) {
          throw new Error(
            `ActionRegistry: ai-decision action '${def.name}' requires an IntegrationRegistry — call configure({ integrations }) first`,
          );
        }
        const { AiDecisionAction } =
          await import('./actions/ai-decision-action.js');
        handler = new AiDecisionAction(def, this.deps.integrations);
        break;
      }
      default: {
        // exhaustive
        const _never: never = def;
        throw new Error(
          `ActionRegistry: unknown action type for ${JSON.stringify(_never)}`,
        );
      }
    }
    this.handlers.set(handler.name(), handler);
    logger.debug(
      { action: handler.name(), type: def.type },
      'ActionRegistry: registered (from definition)',
    );
  }

  async execute(
    actionName: string,
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const handler = this.handlers.get(actionName);
    if (!handler) {
      logger.warn({ actionName }, 'ActionRegistry: unknown action — skipping');
      return;
    }
    await handler.execute(config, context);
  }

  get(name: string): ActionHandler | undefined {
    return this.handlers.get(name);
  }

  has(actionName: string): boolean {
    return this.handlers.has(actionName);
  }

  listNames(): string[] {
    return [...this.handlers.keys()];
  }

  registeredNames(): string[] {
    return Array.from(this.handlers.keys());
  }
}

export const actionRegistry = new ActionRegistry();
