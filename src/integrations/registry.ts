/**
 * Integration registry for pilluclaw workflow engine.
 *
 * Holds typed integration SDK instances keyed by name. The `integration`
 * action type and `ai-decision` action type both look up an integration here
 * by name and call a method on it.
 */
import { logger } from '../logger.js';
import { OpenRouterIntegration } from './openrouter.js';
import { CmdCenterIntegration } from './cmdcenter.js';
import { ClaudeSubscriptionIntegration } from './claude.js';

export type IntegrationMethod = (
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface Integration {
  name(): string;
  /** Map of method name → handler. */
  methods(): Record<string, IntegrationMethod>;
}

export class IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();

  register(integration: Integration): void {
    this.integrations.set(integration.name(), integration);
    logger.debug(
      {
        integration: integration.name(),
        methods: Object.keys(integration.methods()),
      },
      'IntegrationRegistry: registered',
    );
  }

  get(name: string): Integration | undefined {
    return this.integrations.get(name);
  }

  has(name: string): boolean {
    return this.integrations.has(name);
  }

  /** Look up `integration.method` and call it with input. */
  async call(
    integrationName: string,
    methodName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const integration = this.integrations.get(integrationName);
    if (!integration) {
      throw new Error(
        `IntegrationRegistry: unknown integration '${integrationName}'`,
      );
    }
    const method = integration.methods()[methodName];
    if (!method) {
      throw new Error(
        `IntegrationRegistry: integration '${integrationName}' has no method '${methodName}'`,
      );
    }
    return method(input);
  }

  registeredNames(): string[] {
    return Array.from(this.integrations.keys());
  }
}

export const integrationRegistry = new IntegrationRegistry();

/**
 * Register the core set of integrations. Idempotent — safe to call multiple
 * times; later registrations of the same name overwrite.
 */
export function registerCoreIntegrations(
  reg: IntegrationRegistry = integrationRegistry,
): IntegrationRegistry {
  reg.register(new OpenRouterIntegration());
  reg.register(new CmdCenterIntegration());
  reg.register(new ClaudeSubscriptionIntegration());
  return reg;
}
