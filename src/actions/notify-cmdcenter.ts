import { ActionHandler } from '../action-registry.js';
import { logger } from '../logger.js';

export class NotifyCmdCenterAction implements ActionHandler {
  name(): string {
    return 'notify_cmdcenter';
  }

  async execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const apiUrl = process.env.CMDCENTER_API_URL ?? '';
    const botKey = process.env.CMDCENTER_BOT_KEY ?? '';
    const eventType =
      (config.event_type as string) ||
      (context.event as string) ||
      'nanoclaw.event';

    if (!apiUrl) {
      logger.debug('notify_cmdcenter: CMDCENTER_API_URL not set — skipping');
      return;
    }

    const { event: _eventKey, ...payloadData } = context;
    const postPayload = {
      event: eventType,
      source: 'nanoclaw',
      payload: payloadData,
      fired_at: new Date().toISOString(),
    };

    try {
      const res = await fetch(`${apiUrl}/events/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Key': botKey,
        },
        body: JSON.stringify(postPayload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status },
          'notify_cmdcenter: non-OK response',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'notify_cmdcenter: failed to POST (non-fatal)');
    }
  }
}
