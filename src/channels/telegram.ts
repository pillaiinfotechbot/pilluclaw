import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { updateChatName } from '../db.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Bot API channel — long-polling implementation
//
// JID format:  tg:{chat_id}   e.g. tg:-5163439991 (group), tg:123456789 (DM)
// Bot token:   read from .env → TELEGRAM_BOT_TOKEN
// ─────────────────────────────────────────────────────────────────────────────

const POLL_TIMEOUT_SECS = 25; // Telegram long-poll timeout
const RETRY_DELAY_MS = 5_000; // Reconnect delay after errors
const RATE_LIMIT_DELAY = 30_000; // Back-off on 429

interface TgMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    title?: string; // groups
    first_name?: string; // DMs
    last_name?: string; // DMs
    type: 'private' | 'group' | 'supergroup' | 'channel';
  };
  date: number;
  text?: string;
  caption?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  edited_message?: TgMessage;
  edited_channel_post?: TgMessage;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private token: string;
  private botId: number | null = null;
  private connected = false;
  private offset = 0;
  private polling = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    this.token = env.TELEGRAM_BOT_TOKEN ?? '';
  }

  // ── Public interface ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (!this.token) {
      logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram channel disabled');
      return;
    }

    // Verify token and get bot identity
    const me = await this.apiCall<{ id: number; username?: string }>('getMe');
    this.botId = me.id;
    logger.info(
      { botId: me.id, username: me.username },
      'Telegram bot connected',
    );

    this.connected = true;
    this.polling = true;

    // Start poll loop in background — don't await
    this.pollLoop().catch((err) => {
      logger.error({ err }, 'Telegram poll loop crashed');
      this.connected = false;
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.token || !this.connected) {
      logger.warn({ jid }, 'Telegram not connected — message dropped');
      return;
    }
    const chatId = this.jidToChatId(jid);
    try {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      });
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err: unknown) {
      // Fallback: retry without Markdown in case of formatting errors
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes('parse') ||
        errMsg.includes('markdown') ||
        errMsg.includes('entities')
      ) {
        logger.warn({ jid }, 'Markdown parse error — retrying as plain text');
        await this.apiCall('sendMessage', { chat_id: chatId, text });
      } else {
        logger.error({ err, jid }, 'Failed to send Telegram message');
        throw err;
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.polling = false;
    logger.info('Telegram channel disconnected');
  }

  async setTyping(jid: string, _isTyping: boolean): Promise<void> {
    if (!this.token || !this.connected) return;
    try {
      const chatId = this.jidToChatId(jid);
      await this.apiCall('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch (err) {
      logger.debug({ err, jid }, 'Telegram setTyping failed');
    }
  }

  // ── Long-polling loop ──────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.apiCall<TgUpdate[]>('getUpdates', {
          timeout: POLL_TIMEOUT_SECS,
          offset: this.offset,
          allowed_updates: ['message', 'channel_post', 'edited_message'],
        });

        for (const update of updates) {
          try {
            this.offset = update.update_id + 1;
            const msg =
              update.message ?? update.channel_post ?? update.edited_message;
            if (msg) await this.handleMessage(msg);
          } catch (err) {
            logger.error(
              { err, update_id: update.update_id },
              'Error handling Telegram update',
            );
          }
        }
      } catch (err: unknown) {
        if (!this.polling) break;

        const errMsg = err instanceof Error ? err.message : String(err);

        if (errMsg.includes('401') || errMsg.includes('403')) {
          logger.error('Telegram bot token invalid or bot kicked — stopping');
          this.connected = false;
          this.polling = false;
          break;
        }

        if (errMsg.includes('429')) {
          logger.warn(
            `Telegram rate limited — backing off ${RATE_LIMIT_DELAY}ms`,
          );
          await this.sleep(RATE_LIMIT_DELAY);
          continue;
        }

        logger.warn(
          { err },
          `Telegram poll error — retrying in ${RETRY_DELAY_MS}ms`,
        );
        await this.sleep(RETRY_DELAY_MS);
      }
    }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const jid = `tg:${chatId}`;
    const isGroup = msg.chat.type !== 'private';

    // Determine chat name
    const chatName =
      msg.chat.title ??
      [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') ??
      String(chatId);

    const timestamp = new Date(msg.date * 1000).toISOString();

    // Update chat name in DB
    updateChatName(jid, chatName);

    // Always notify about chat metadata
    this.opts.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    // Only deliver message for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const content = msg.text ?? msg.caption ?? '';
    if (!content) return;

    // Sender info
    const senderId = msg.from?.id ?? 0;
    const senderName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
      msg.from?.username ||
      String(senderId);

    // Bot detection: message came from this bot
    const isBotMessage = !!(
      msg.from?.is_bot ||
      (this.botId !== null && senderId === this.botId)
    );

    const newMsg: NewMessage = {
      id: String(msg.message_id),
      chat_jid: jid,
      sender: `tg:${senderId}`,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    };

    this.opts.onMessage(jid, newMsg);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private jidToChatId(jid: string): string | number {
    return jid.replace(/^tg:/, '');
  }

  private async apiCall<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: params ? 'POST' : 'GET',
      headers: params ? { 'Content-Type': 'application/json' } : undefined,
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout((POLL_TIMEOUT_SECS + 10) * 1000),
    });

    const data = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };

    if (!data.ok) {
      throw new Error(
        `Telegram API ${method} failed [${data.error_code}]: ${data.description}`,
      );
    }

    return data.result as T;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

registerChannel('telegram', (opts: ChannelOpts) => new TelegramChannel(opts));
