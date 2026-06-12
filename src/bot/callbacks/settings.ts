import { Context, Bot, InlineKeyboard } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import { getCurrentCdp } from '../../services/cdpBridgeManager';
import { ConfigLoader } from '../../utils/configLoader';
import { loadConfig } from '../../utils/config';
import { buildModeUI } from '../../ui/modeUi';
import { buildModelsUI } from '../../ui/modelsUi';
import { MODE_DISPLAY_NAMES } from '../../services/modeService';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger';

export async function handleSettings(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const { bridge, modeService, modelService } = deps;

    // Mode selection
    if (data.startsWith('mode_select:')) {
        const selectedMode = data.replace('mode_select:', '');
        modeService.setMode(selectedMode);
        const cdp = getCurrentCdp(bridge);
        if (cdp) {
            const res = await cdp.setUiMode(selectedMode);
            if (!res.ok) logger.warn(`[Mode] UI switch failed: ${res.error}`);
        }
        const { text, keyboard } = await buildModeUI(modeService, { getCurrentCdp: () => getCurrentCdp(bridge) });
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (e) {
            logger.debug('[modeSelect] editMessageText failed (expected if unchanged):', e);
        }
        await ctx.answerCallbackQuery({ text: `Mode: ${MODE_DISPLAY_NAMES[selectedMode] || selectedMode}` });
        return true;
    }

    // Exhausted model button — show alert toast
    if (data.startsWith('model_exhausted_')) {
        const modelName = data.replace('model_exhausted_', '');
        await ctx.answerCallbackQuery({ text: `⛔ ${modelName} is exhausted. Wait for quota reset or pick another model.`, show_alert: true });
        return true;
    }

    // Model selection
    if (data.startsWith('model_btn_')) {
        const modelName = data.replace('model_btn_', '');
        const cdp = getCurrentCdp(bridge);
        if (!cdp) {
            await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' });
            return true;
        }
        const res = await cdp.setUiModel(modelName);
        if (res.ok) {
            const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
            if (payload) {
                try {
                    await ctx.editMessageText(payload.text, { parse_mode: 'HTML', reply_markup: payload.keyboard });
                } catch (e) {
                    logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
                }
            }
            await ctx.answerCallbackQuery({ text: `Model: ${res.model}` });
        } else {
            await ctx.answerCallbackQuery({ text: res.error || 'Failed to change model.' });
        }
        return true;
    }

    // Model refresh
    if (data === 'model_refresh_btn') {
        const cdp = getCurrentCdp(bridge);
        if (!cdp) {
            await ctx.answerCallbackQuery({ text: 'Not connected.' });
            return true;
        }
        const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
        if (payload) {
            try {
                await ctx.editMessageText(payload.text, { parse_mode: 'HTML', reply_markup: payload.keyboard });
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
            }
        }
        await ctx.answerCallbackQuery({ text: 'Refreshed' });
        return true;
    }

    // Mirror mode settings
    if (data.startsWith('set_mirror_mode:') || data.startsWith('mirror_all:')) {
        let mode: 'all' | 'active' | 'telegram_only' = 'active';
        if (data.startsWith('set_mirror_mode:')) {
            mode = data.substring('set_mirror_mode:'.length) as any;
        } else {
            const isMirrorAll = data.substring('mirror_all:'.length) === 'on';
            mode = isMirrorAll ? 'all' : 'active';
        }
        ConfigLoader.save({ mirrorMode: mode, onlyActiveWorkspaceMessages: mode === 'active' });
        
        const conf = loadConfig();
        const mirrorMode = conf.mirrorMode || (conf.onlyActiveWorkspaceMessages ? 'active' : 'all');
        const keyboard = new InlineKeyboard()
            .text(mirrorMode === 'all' ? `🟢 ${t('all')}` : `⚪ ${t('all')}`, 'set_mirror_mode:all').row()
            .text(mirrorMode === 'active' ? `🟢 ${t('active')}` : `⚪ ${t('active')}`, 'set_mirror_mode:active').row()
            .text(mirrorMode === 'telegram_only' ? `🟢 ${t('telegram_only')}` : `⚪ ${t('telegram_only')}`, 'set_mirror_mode:telegram_only');

        await ctx.editMessageText(
            `<b>⚙️ ${t('Mirror Settings')}</b>\n\n` +
            `${t('Current mirror mode:')} <b>${t(mirrorMode)}</b>\n\n` +
            `• <b>${t('all')}</b>: ${t('Mirror all open VS Code windows.')}\n` +
            `• <b>${t('active')}</b>: ${t('Mirror only the active (bound) workspace.')}\n` +
            `• <b>${t('telegram_only')}</b>: ${t('Mirror answers only if the prompt was sent from Telegram.')}`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        ).catch(() => {});
        await ctx.answerCallbackQuery({ text: `${t('Mirror Mode')}: ${t(mirrorMode)}` });
        return true;
    }

    return false;
}
