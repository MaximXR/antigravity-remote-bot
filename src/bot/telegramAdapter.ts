import { Api, InlineKeyboard, InputFile } from 'grammy';
import { IMessengerPort, ChannelContext, AbstractButton } from '../services/messengerPort';
import { TelegramTopicManager } from './telegramTopicManager';
import { logger } from '../utils/logger';

export function buildTelegramKeyboard(buttons?: AbstractButton[] | AbstractButton[][]): InlineKeyboard | undefined {
    if (!buttons || buttons.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    const is2D = Array.isArray(buttons[0]);
    if (is2D) {
        const rows = buttons as AbstractButton[][];
        for (let i = 0; i < rows.length; i++) {
            for (const btn of rows[i]) {
                keyboard.text(btn.text, btn.action);
            }
            if (i < rows.length - 1) {
                keyboard.row();
            }
        }
    } else {
        const btnList = buttons as AbstractButton[];
        for (let i = 0; i < btnList.length; i++) {
            keyboard.text(btnList[i].text, btnList[i].action);
            if (i < btnList.length - 1) {
                keyboard.row();
            }
        }
    }
    return keyboard;
}

export class TelegramAdapter implements IMessengerPort {
    private readonly api: Api;
    private readonly topicManager?: TelegramTopicManager;

    constructor(api: Api, topicManager?: TelegramTopicManager) {
        this.api = api;
        this.topicManager = topicManager;
    }

    public getApi(): Api {
        return this.api;
    }

    private buildKeyboard(buttons?: AbstractButton[] | AbstractButton[][]): InlineKeyboard | undefined {
        return buildTelegramKeyboard(buttons);
    }

    public async sendMessage(channel: ChannelContext, text: string, buttons?: AbstractButton[] | AbstractButton[][]): Promise<number | null> {
        logger.debug(`[TelegramAdapter:sendMessage] Sending message to chatId ${channel.chatId}, threadId ${channel.threadId}...`);
        try {
            const markup = this.buildKeyboard(buttons);
            logger.debug(`[TelegramAdapter:sendMessage] Markup built successfully`);
            const msg = await this.api.sendMessage(channel.chatId, text, {
                parse_mode: 'HTML',
                message_thread_id: channel.threadId,
                reply_markup: markup,
            });
            logger.debug(`[TelegramAdapter:sendMessage] api.sendMessage succeeded: msgId ${msg.message_id}`);
            return msg.message_id;
        } catch (e: any) {
            logger.error('[TelegramAdapter:sendMessage] Failed:', e?.message || e);
            return null;
        }
    }

    public async editMessage(channel: ChannelContext, messageId: number, text: string, buttons?: AbstractButton[] | AbstractButton[][]): Promise<void> {
        try {
            const markup = this.buildKeyboard(buttons);
            await this.api.editMessageText(channel.chatId, messageId, text, {
                parse_mode: 'HTML',
                reply_markup: markup,
            });
        } catch (e: any) {
            const desc = e?.description || e?.message || '';
            if (!desc.includes('message is not modified')) {
                logger.error('[TelegramAdapter:editMessage] Failed:', desc);
            }
        }
    }

    public async sendDocument(channel: ChannelContext, buffer: Buffer, filename: string, caption?: string, buttons?: AbstractButton[] | AbstractButton[][]): Promise<void> {
        try {
            const markup = this.buildKeyboard(buttons);
            await this.api.sendDocument(channel.chatId, new InputFile(buffer, filename), {
                caption,
                message_thread_id: channel.threadId,
                reply_markup: markup,
            });
        } catch (e: any) {
            logger.error('[TelegramAdapter:sendDocument] Failed:', e?.message || e);
        }
    }

    public async sendPhoto(channel: ChannelContext, buffer: Buffer, filename: string, caption?: string): Promise<void> {
        try {
            await this.api.sendPhoto(channel.chatId, new InputFile(buffer, filename), {
                caption,
                message_thread_id: channel.threadId,
            });
        } catch (e: any) {
            logger.error('[TelegramAdapter:sendPhoto] Failed:', e?.message || e);
        }
    }

    public async renameChannelTopic(channel: ChannelContext, newName: string): Promise<void> {
        if (this.topicManager && channel.threadId) {
            await this.topicManager.renameTopic(channel.threadId, newName);
        }
    }

    public async cleanMessageButtons(channel: ChannelContext, messageId: number): Promise<void> {
        try {
            await this.api.editMessageReplyMarkup(channel.chatId, messageId, { reply_markup: undefined });
        } catch (e: any) {
            logger.debug('[TelegramAdapter:cleanMessageButtons] Failed (expected if already removed):', e?.message || e);
        }
    }
}
