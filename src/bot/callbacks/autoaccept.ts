import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import {
    AUTOACCEPT_TOGGLE_MASTER,
    AUTOACCEPT_TOGGLE_CAT_PREFIX,
    AUTOACCEPT_ALL_ON,
    AUTOACCEPT_ALL_OFF,
    AUTOACCEPT_BTN_REFRESH,
    sendAutoAcceptUI,
} from '../../ui/autoAcceptUi';
import { AutoAcceptSettings } from '../../services/autoAcceptService';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger';

export async function handleAutoAccept(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const { bridge } = deps;

    if (data === AUTOACCEPT_TOGGLE_MASTER) {
        bridge.autoAccept.toggleMaster(!bridge.autoAccept.isEnabled());
        await sendAutoAcceptUI(
            async (text, keyboard) => {
                try {
                    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            },
            bridge.autoAccept,
        );
        await ctx.answerCallbackQuery({ text: t('Auto-accept status updated') });
        return true;
    }

    if (data.startsWith(AUTOACCEPT_TOGGLE_CAT_PREFIX)) {
        const cat = data.substring(AUTOACCEPT_TOGGLE_CAT_PREFIX.length) as keyof Omit<AutoAcceptSettings, 'enabled'>;
        const s = bridge.autoAccept.getSettings();
        bridge.autoAccept.toggleCategory(cat, !s[cat]);
        await sendAutoAcceptUI(
            async (text, keyboard) => {
                try {
                    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            },
            bridge.autoAccept,
        );

        const catLabels: Record<keyof Omit<AutoAcceptSettings, 'enabled'>, string> = {
            fileEdits: t('File Edits'),
            consoleCommands: t('Console'),
            readAccess: t('Read'),
            urlAccess: t('URL'),
            otherRequests: t('Other')
        };
        const label = catLabels[cat] || cat;
        await ctx.answerCallbackQuery({ text: `${label}: ${!s[cat] ? 'ON' : 'OFF'}` });
        return true;
    }

    if (data === AUTOACCEPT_ALL_ON) {
        bridge.autoAccept.toggleMaster(true);
        bridge.autoAccept.toggleCategory('fileEdits', true);
        bridge.autoAccept.toggleCategory('consoleCommands', true);
        bridge.autoAccept.toggleCategory('readAccess', true);
        bridge.autoAccept.toggleCategory('urlAccess', true);
        bridge.autoAccept.toggleCategory('otherRequests', true);
        await sendAutoAcceptUI(
            async (text, keyboard) => {
                try {
                    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            },
            bridge.autoAccept,
        );
        await ctx.answerCallbackQuery({ text: t('All categories enabled') });
        return true;
    }

    if (data === AUTOACCEPT_ALL_OFF) {
        bridge.autoAccept.toggleMaster(false);
        bridge.autoAccept.toggleCategory('fileEdits', false);
        bridge.autoAccept.toggleCategory('consoleCommands', false);
        bridge.autoAccept.toggleCategory('readAccess', false);
        bridge.autoAccept.toggleCategory('urlAccess', false);
        bridge.autoAccept.toggleCategory('otherRequests', false);
        await sendAutoAcceptUI(
            async (text, keyboard) => {
                try {
                    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            },
            bridge.autoAccept,
        );
        await ctx.answerCallbackQuery({ text: t('All categories disabled') });
        return true;
    }

    if (data === AUTOACCEPT_BTN_REFRESH) {
        await sendAutoAcceptUI(
            async (text, keyboard) => {
                try {
                    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            },
            bridge.autoAccept,
        );
        await ctx.answerCallbackQuery({ text: t('Refreshed') });
        return true;
    }

    return false;
}
