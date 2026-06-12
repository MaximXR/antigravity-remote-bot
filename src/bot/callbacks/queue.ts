import { Context, Bot, InlineKeyboard } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import {
    INTERRUPT_QUEUE_PREFIX,
    INTERRUPT_NOW_PREFIX,
    INTERRUPT_DISCARD_PREFIX,
} from '../../ui/queueUi';
import {
    shiftPendingInterrupt,
} from '../../services/interruptState';
import {
    userStopRequestedChannels,
    lastChoicesCache,
} from '../botState';
import {
    getCurrentCdp,
} from '../../services/cdpBridgeManager';
import { resolveWorkspaceAndCdp, channelKeyFromChannel } from '../../services/workspaceResolver';
import { mirrorResponseToTelegram } from '../tgMirror';
import { cleanupInboundImageAttachments } from '../../utils/imageHandler';
import { buildClickScript, RESPONSE_SELECTORS } from '../../utils/domSelectors';
import { escapeHtml } from '../../utils/telegramFormatter';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

export async function handleQueue(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const {
        bridge,
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
        modelService,
        modeService,
        workspaceBindingRepo,
        promptDispatcher,
    } = deps;

    // Stop generation button click
    if (data === 'stop_generation') {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
        if (!cdp) {
            await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' });
            return true;
        }
        try {
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
            } catch (e) {
                logger.debug('[stop:markup] Failed to clear markup:', e);
            }

            const contextId = cdp.getPrimaryContextId();
            const callParams: Record<string, unknown> = { expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON, returnByValue: true, awaitPromise: false };
            if (contextId !== null) callParams.contextId = contextId;
            const result = await cdp.call('Runtime.evaluate', callParams);
            const value = result?.result?.value;

            userStopRequestedChannels.add(channelKey(ch));
            const keyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');

            if (value?.ok) {
                await ctx.answerCallbackQuery({ text: 'Stopping Antigravity generation...' });
                await bot.api.sendMessage(ch.chatId, '<b>⏹️ Generation Interrupted</b>\nAI response generation was safely stopped.', {
                    parse_mode: 'HTML',
                    message_thread_id: ch.threadId,
                    reply_markup: keyboard
                });
            } else {
                await ctx.answerCallbackQuery({ text: 'Stop button not found, but you can undo changes.' });
                await bot.api.sendMessage(ch.chatId, '<b>⏹️ Generation Interrupted / Already Stopped</b>\nCould not click Stop button in IDE, but you can still undo any pending changes.', {
                    parse_mode: 'HTML',
                    message_thread_id: ch.threadId,
                    reply_markup: keyboard
                });
            }
        } catch (e: any) {
            await ctx.answerCallbackQuery({ text: `Error: ${e.message}`, show_alert: true });
        }
        return true;
    }

    // Undo last message button click
    if (data === 'undo_last') {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
        if (!cdp) {
            await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' });
            return true;
        }
        try {
            await ctx.answerCallbackQuery({ text: '↩️ ' + t('Rolling back last changes...') });
            const rollbackResult = await chatSessionService.rollbackLastChanges(cdp);
            if (rollbackResult.ok) {
                await bot.api.sendMessage(ch.chatId, '✅ ' + t('Last changes successfully rolled back in IDE.'), {
                    message_thread_id: ch.threadId,
                });
            } else {
                await bot.api.sendMessage(ch.chatId, `❌ ${t('Failed to rollback')}: ${rollbackResult.error || t('Undo button not found')}`, {
                    message_thread_id: ch.threadId,
                });
            }
        } catch (e: any) {
            await bot.api.sendMessage(ch.chatId, `❌ ${t('Failed to rollback')}: ${e.message}`, {
                message_thread_id: ch.threadId,
            });
        }
        return true;
    }

    // Interrupt buttons
    if (data.startsWith(INTERRUPT_QUEUE_PREFIX) || data.startsWith(INTERRUPT_NOW_PREFIX) || data.startsWith(INTERRUPT_DISCARD_PREFIX)) {
        const targetKey = data.startsWith(INTERRUPT_QUEUE_PREFIX)
            ? data.slice(INTERRUPT_QUEUE_PREFIX.length)
            : data.startsWith(INTERRUPT_NOW_PREFIX)
                ? data.slice(INTERRUPT_NOW_PREFIX.length)
                : data.slice(INTERRUPT_DISCARD_PREFIX.length);

        if (data.startsWith(INTERRUPT_DISCARD_PREFIX)) {
            const discarded = shiftPendingInterrupt(targetKey);
            if (discarded?.inboundImages?.length) {
                cleanupInboundImageAttachments(discarded.inboundImages).catch(() => {});
            }
            try {
                await ctx.editMessageText('🗑 Message discarded.');
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed:', e);
            }
            await ctx.answerCallbackQuery({ text: 'Discarded' });
            return true;
        }

        const pending = shiftPendingInterrupt(targetKey);
        if (!pending) {
            try {
                await ctx.editMessageText('✅ Task finished — your message was already processed.');
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed:', e);
            }
            await ctx.answerCallbackQuery({ text: 'Already processed' });
            return true;
        }

        const projectName = targetKey.startsWith('ws:') ? targetKey.slice(3) : null;
        const freshCdp = projectName ? bridge.pool.getConnected(projectName) : null;

        if (data.startsWith(INTERRUPT_NOW_PREFIX)) {
            try {
                await ctx.editMessageText('⚡ Stopping current task and sending your message…');
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed:', e);
            }
            await ctx.answerCallbackQuery({ text: 'Stopping & sending...' });

            try {
                const contextId = pending.cdp.getPrimaryContextId();
                const callParams: Record<string, unknown> = { expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON, returnByValue: true, awaitPromise: false };
                if (contextId !== null) callParams.contextId = contextId;
                await pending.cdp.call('Runtime.evaluate', callParams);
                userStopRequestedChannels.add(channelKey(pending.channel));
            } catch (e) {
                logger.debug('[interrupt:now] Stop button click failed:', e);
            }

            const dispatchCdp = freshCdp ?? pending.cdp;
            promptDispatcher.send({
                channel: pending.channel,
                prompt: pending.prompt,
                cdp: dispatchCdp,
                inboundImages: pending.inboundImages,
                options: pending.options,
            }).catch((e) => {
                logger.error('[interrupt:now] dispatch failed:', e);
            });
            return true;
        }

        // INTERRUPT_QUEUE_PREFIX
        try {
            await ctx.editMessageText('📥 Message queued — will send after current task.');
        } catch (e) {
            logger.debug('[editMsg] Telegram edit failed:', e);
        }
        await ctx.answerCallbackQuery({ text: 'Queued' });

        const dispatchCdp = freshCdp ?? pending.cdp;
        promptDispatcher.send({
            channel: pending.channel,
            prompt: pending.prompt,
            cdp: dispatchCdp,
            inboundImages: pending.inboundImages,
            options: pending.options,
        }).catch((e) => {
            logger.error('[interrupt:queue] dispatch failed:', e);
        });
        return true;
    }

    // AI choice callback
    if (data.startsWith('ai_choice:')) {
        const parts = data.split(':');
        const projectName = parts[1];
        const idx = parseInt(parts[2], 10);
        const chKey = channelKey(ch);
        const choices = lastChoicesCache.get(chKey);

        if (choices && idx >= 0 && idx < choices.length) {
            const choiceText = choices[idx];
            const cdp = bridge.pool.getConnected(projectName) ?? getCurrentCdp(bridge);
            if (cdp) {
                const clicked = await cdp.call('Runtime.evaluate', {
                    expression: buildClickScript(choiceText),
                    returnByValue: true,
                }).catch(() => null);

                const ok = clicked?.result?.value?.ok === true;
                if (ok) {
                    await ctx.answerCallbackQuery({ text: `Selected: ${choiceText}` });
                    try {
                        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
                    } catch (e) {
                        logger.debug('[Choices] Reply markup edit failed:', e);
                    }
                    
                    if (!promptDispatcher.isBusy(ch, cdp)) {
                        logger.info(`[ChoicesCallback] Starting passive monitoring for workspace ${projectName}`);
                        const mirrorPromise = mirrorResponseToTelegram(bridge, ch, cdp, `Choice "${choiceText}"`, {
                            chatSessionService,
                            chatSessionRepo,
                            topicManager,
                            titleGenerator,
                            modelService,
                            modeService,
                            workspaceBindingRepo
                        });
                        promptDispatcher.acquireLock(ch, cdp, mirrorPromise);
                    }
                } else {
                    await ctx.answerCallbackQuery({ text: 'Option not found in IDE. Please try again.' });
                }
            } else {
                await ctx.answerCallbackQuery({ text: 'Workspace connection not active.' });
            }
        } else {
            await ctx.answerCallbackQuery({ text: 'Choices cache expired.' });
        }
        return true;
    }

    return false;
}
