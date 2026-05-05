import { ActionHandler } from '../action-registry.js';
import { resolveTemplate } from '../workflow-engine-helpers.js';
import { logger } from '../logger.js';

export class SendTelegramAction implements ActionHandler {
  name(): string {
    return 'send_telegram';
  }

  async execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const chatId = config.chat_id as string | undefined;
    const messageTemplate = config.message as string | undefined;
    if (!chatId || !messageTemplate) {
      logger.warn({ config }, 'send_telegram: missing chat_id or message');
      return;
    }
    const message = resolveTemplate(messageTemplate, context);
    // TODO(Task 6): Wire live channel instance. Channel registry stores factories,
    // not live instances. Task 6 needs to add getActiveChannel(name) to channels/registry.ts
    // or convert this to a factory function that receives the active channel.
    logger.warn(
      { chatId, message: message.slice(0, 50) },
      'send_telegram: channel not wired yet — logged only',
    );
  }
}
