import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import {
    PLAN_VIEW_BTN,
    PLAN_PROCEED_BTN,
    PLAN_EDIT_BTN,
    PLAN_REFRESH_BTN,
    PLAN_PAGE_PREFIX,
    buildPlanNotificationUI,
    buildPlanContentUI,
    paginatePlanContent,
} from '../../ui/planUi';
import { parsePlanningCustomId } from '../../services/cdpBridgeManager';
import { buildTelegramKeyboard } from '../telegramAdapter';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { planEditPendingChannels, planContentCache } from '../botState';
import { escapeHtml } from '../../utils/telegramFormatter';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

export async function handlePlans(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const { bridge } = deps;

    // Legacy/Custom ID parse
    const planningAction = parsePlanningCustomId(data);
    if (planningAction) {
        const projectName = planningAction.projectName ?? bridge.lastActiveWorkspace;
        let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
        if (!detector) {
            const resolved = await deps.resolveWorkspaceAndCdp(ch);
            if (resolved.ok) {
                detector = bridge.pool.getPlanningDetector(resolved.projectName);
            }
        }
        if (!detector) {
            await ctx.answerCallbackQuery({ text: 'Planning detector not found.' });
            return true;
        }

        if (planningAction.action === 'open') {
            const clicked = await detector.clickOpenButton();
            if (clicked) {
                await new Promise(r => setTimeout(r, 500));
                let planContent: string | null = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    planContent = await detector.extractPlanContent();
                    if (planContent) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (planContent) {
                    const chKey = channelKey(ch);
                    const pages = paginatePlanContent(planContent);
                    planContentCache.set(chKey, pages);
                    const targetChannelStr = ch.threadId ? String(ch.threadId) : String(ch.chatId);
                    const lastInfo = detector.getLastDetectedInfo();
                    const { text: pageText, buttons: pageButtons } = buildPlanContentUI(pages, 0, projectName || '', targetChannelStr, lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
                    const pageKeyboard = buildTelegramKeyboard(pageButtons);
                    await bot.api.sendMessage(ch.chatId, pageText, { parse_mode: 'HTML', message_thread_id: ch.threadId, reply_markup: pageKeyboard });
                }
            }
            await ctx.answerCallbackQuery({ text: clicked ? 'Opened' : 'Open button not found.' });
        } else {
            const clicked = await detector.clickProceedButton();
            if (clicked) {
                try {
                    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            }
            await ctx.answerCallbackQuery({ text: clicked ? 'Proceeding...' : 'Proceed button not found.' });
        }
        return true;
    }

    // New planning UI buttons
    if (data.startsWith(PLAN_VIEW_BTN + ':')) {
        const suffix = data.substring(PLAN_VIEW_BTN.length + 1);
        const [projectName] = suffix.split(':');
        let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
        if (!detector) {
            const resolved = await deps.resolveWorkspaceAndCdp(ch);
            if (resolved.ok) {
                detector = bridge.pool.getPlanningDetector(resolved.projectName);
            }
        }
        if (!detector) {
            await ctx.answerCallbackQuery({ text: 'Planning detector not found.' });
            return true;
        }

        const clicked = await detector.clickOpenButton();
        if (clicked) {
            await new Promise(r => setTimeout(r, 500));
            let planContent: string | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                planContent = await detector.extractPlanContent();
                if (planContent) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (planContent) {
                const chKey = channelKey(ch);
                const pages = paginatePlanContent(planContent);
                planContentCache.set(chKey, pages);
                const targetChannelStr = ch.threadId ? String(ch.threadId) : String(ch.chatId);
                const lastInfo = detector.getLastDetectedInfo();
                const { text: pageText, buttons: pageButtons } = buildPlanContentUI(pages, 0, projectName, targetChannelStr, lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
                const pageKeyboard = buildTelegramKeyboard(pageButtons);
                await bot.api.sendMessage(ch.chatId, pageText, { parse_mode: 'HTML', message_thread_id: ch.threadId, reply_markup: pageKeyboard });
            } else {
                await bot.api.sendMessage(ch.chatId, `⚠️ <b>Extraction Failed</b>\n\nThe ${projectName ? escapeHtml(projectName) : 'workspace'} UI was instructed to open the file, but we couldn't extract the text content to show inside Telegram. Please check your IDE.`, { parse_mode: 'HTML', message_thread_id: ch.threadId });
            }
        }
        await ctx.answerCallbackQuery({ text: clicked ? 'Opened' : 'Open button not found.' });
        return true;
    }

    if (data.startsWith(PLAN_PROCEED_BTN + ':')) {
        const suffix = data.substring(PLAN_PROCEED_BTN.length + 1);
        const [projectName] = suffix.split(':');
        let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
        if (!detector) {
            const resolved = await deps.resolveWorkspaceAndCdp(ch);
            if (resolved.ok) {
                detector = bridge.pool.getPlanningDetector(resolved.projectName);
            }
        }
        if (!detector) {
            await ctx.answerCallbackQuery({ text: 'Planning detector not found.' });
            return true;
        }

        const clicked = await detector.clickProceedButton();
        if (clicked) {
            planEditPendingChannels.delete(channelKey(ch));
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
            }
        }
        await ctx.answerCallbackQuery({ text: clicked ? 'Proceeding...' : 'Proceed button not found.' });
        return true;
    }

    if (data.startsWith(PLAN_EDIT_BTN + ':')) {
        const suffix = data.substring(PLAN_EDIT_BTN.length + 1);
        const [projectName] = suffix.split(':');
        planEditPendingChannels.set(channelKey(ch), { projectName });
        await ctx.answerCallbackQuery({ text: 'Type your edit instructions (or /cancel).' });
        await bot.api.sendMessage(ch.chatId, '<b>Edit Plan</b>\n\nType your plan edit instructions below.\nSend <code>/cancel</code> to cancel.', { parse_mode: 'HTML', message_thread_id: ch.threadId });
        return true;
    }

    if (data.startsWith(PLAN_REFRESH_BTN + ':')) {
        const suffix = data.substring(PLAN_REFRESH_BTN.length + 1);
        const [projectName, targetChannelStr] = suffix.split(':');
        let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
        if (!detector) {
            const resolved = await deps.resolveWorkspaceAndCdp(ch);
            if (resolved.ok) {
                detector = bridge.pool.getPlanningDetector(resolved.projectName);
            }
        }
        if (!detector) {
            await ctx.answerCallbackQuery({ text: 'Planning detector not found.' });
            return true;
        }

        const info = detector.getLastDetectedInfo();
        if (info) {
            const { text: uiText, buttons: uiButtons } = buildPlanNotificationUI(info, projectName, targetChannelStr || String(ch.chatId));
            const uiKeyboard = buildTelegramKeyboard(uiButtons);
            try {
                await ctx.editMessageText(uiText, { parse_mode: 'HTML', reply_markup: uiKeyboard });
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
            }
        }
        await ctx.answerCallbackQuery({ text: 'Refreshed' });
        return true;
    }

    // Plan pagination
    if (data.startsWith(PLAN_PAGE_PREFIX + ':')) {
        const rest = data.substring(PLAN_PAGE_PREFIX.length + 1);
        const colonIdx = rest.indexOf(':');
        const page = parseInt(rest.substring(0, colonIdx), 10);
        const suffix = rest.substring(colonIdx + 1);
        const [projectName, targetChannelStr] = suffix.split(':');
        const chKey = channelKey(ch);
        const pages = planContentCache.get(chKey);
        if (!pages || isNaN(page)) {
            await ctx.answerCallbackQuery({ text: 'Page not found.' });
            return true;
        }

        let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
        if (!detector) {
            const resolved = await deps.resolveWorkspaceAndCdp(ch);
            if (resolved.ok) {
                detector = bridge.pool.getPlanningDetector(resolved.projectName);
            }
        }
        const lastInfo = detector?.getLastDetectedInfo();

        const { text: pageText, buttons: pageButtons } = buildPlanContentUI(pages, page, projectName, targetChannelStr || String(ch.chatId), lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
        const pageKeyboard = buildTelegramKeyboard(pageButtons);
        try {
            await ctx.editMessageText(pageText, { parse_mode: 'HTML', reply_markup: pageKeyboard });
        } catch (e) {
            logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
        }
        await ctx.answerCallbackQuery({ text: `Page ${page + 1}/${pages.length}` });
        return true;
    }

    return false;
}
