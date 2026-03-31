/**
 * Virtual Channel — handles JIDs with the "virtual:" prefix.
 *
 * Virtual JIDs (e.g. virtual:ceo, virtual:cto) are used by the CMDCenter
 * task poller to route tasks to Docker agent containers without going through
 * a real chat platform (Telegram/WhatsApp). This channel acts as a no-op
 * transport: it is always "connected", accepts any virtual JID, and silently
 * discards outbound sendMessage calls (agent output already flows back to
 * CMDCenter via the API, not via a chat message).
 */

import { Channel } from '../types.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';

class VirtualChannel implements Channel {
  name = 'virtual';

  async connect(): Promise<void> {
    logger.info('VirtualChannel: ready (handles virtual:xxx JIDs)');
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('virtual:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Agent output for virtual JIDs flows back through the CMDCenter API
    // (POST /tasks/{id}/communications). Nothing to send to a chat platform.
    logger.debug(
      { jid, chars: text.length },
      'VirtualChannel: sendMessage (no-op)',
    );
  }

  async disconnect(): Promise<void> {
    logger.info('VirtualChannel: disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op — no chat platform to show typing indicator on
  }
}

registerChannel('virtual', () => new VirtualChannel());
