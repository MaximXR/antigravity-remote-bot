import { Bot, Context, InlineKeyboard } from 'grammy';
import path from 'path';
import * as fs from 'fs';

import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { ConfigLoader } from '../utils/configLoader';
import { loadConfig } from '../utils/config';
import { escapeHtml, formatForTelegram, splitTelegramHtml } from '../utils/telegramFormatter';
import { htmlToTelegramHtml } from '../utils/htmlToTelegramMarkdown';

import {
    CLEANUP_ARCHIVE_BTN,
    CLEANUP_DELETE_BTN,
    CLEANUP_CANCEL_BTN,
    CLEANUP_DISK_ORPHANED_BTN,
    CLEANUP_DISK_ALL_INACTIVE_BTN,
} from '../commands/cleanupCommandHandler';

import {
    AUTOACCEPT_TOGGLE_MASTER,
    AUTOACCEPT_TOGGLE_CAT_PREFIX,
    AUTOACCEPT_ALL_ON,
    AUTOACCEPT_ALL_OFF,
    AUTOACCEPT_BTN_REFRESH,
    sendAutoAcceptUI,
} from '../ui/autoAcceptUi';

import {
    PLAN_VIEW_BTN,
    PLAN_PROCEED_BTN,
    PLAN_EDIT_BTN,
    PLAN_REFRESH_BTN,
    PLAN_PAGE_PREFIX,
    buildPlanNotificationUI,
    buildPlanContentUI,
    paginatePlanContent,
} from '../ui/planUi';

import {
    PROJECT_SELECT_ID,
    PROJECT_PAGE_PREFIX,
    parseProjectPageId,
    projectPathCache,
    buildWorkspaceListUI,
} from '../ui/projectListUi';

import {
    SESSION_SELECT_ID,
    isSessionSelectId,
    sessionTitleCache,
    buildSessionPickerUI,
} from '../ui/sessionPickerUi';

import {
    TEMPLATE_BTN_PREFIX,
    parseTemplateButtonId,
    sendTemplateUI,
} from '../ui/templateUi';

import {
    INTERRUPT_QUEUE_PREFIX,
    INTERRUPT_NOW_PREFIX,
    INTERRUPT_DISCARD_PREFIX,
    safeCallbackKey,
} from '../ui/queueUi';

import {
    addPendingInterrupt,
    getFirstPendingInterrupt,
    shiftPendingInterrupt,
    drainPendingInterrupts,
    hasPendingInterrupts,
    consumeBypass,
    MAX_QUEUE_DEPTH,
} from '../services/interruptState';

import {
    telegramSentPrompts,
    userStopRequestedChannels,
    statusWindowPathCache,
    restoreWindowPathCache,
    promptSelectionSentChannels,
    lastChoicesCache,
    planEditPendingChannels,
    planContentCache,
} from './botState';

import {
    sendPromptToAntigravity,
    mirrorResponseToTelegram,
} from './tgMirror';

import { ModeService, MODE_DISPLAY_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceService } from '../services/workspaceService';
import { CdpService } from '../services/cdpService';
import { ChatSessionService } from '../services/chatSessionService';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { PromptDispatcher } from '../services/promptDispatcher';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { CleanupCommandHandler } from '../commands/cleanupCommandHandler';
import { TelegramTopicManager } from './telegramTopicManager';
import {
    CdpBridge,
    getCurrentCdp,
    registerApprovalSessionChannel,
    parseApprovalCustomId,
    parseErrorPopupCustomId,
    parsePlanningCustomId,
    buildApprovalCustomId
} from '../services/cdpBridgeManager';
import { ChannelContext } from '../services/messengerPort';
import { buildTelegramKeyboard } from './telegramAdapter';
import { channelKeyFromChannel } from '../services/workspaceResolver';
import { buildModeUI } from '../ui/modeUi';
import { buildModelsUI } from '../ui/modelsUi';
import { buildClickScript, RESPONSE_SELECTORS } from '../utils/domSelectors';
import { AutoAcceptSettings } from '../services/autoAcceptService';
import { cleanupInboundImageAttachments } from '../utils/imageHandler';

const channelKey = channelKeyFromChannel;
const TELEGRAM_MSG_LIMIT = 4096;

export interface CallbackDependencies {
    config: any;
    bridge: CdpBridge;
    modeService: ModeService;
    modelService: ModelService;
    templateRepo: TemplateRepository;
    workspaceBindingRepo: WorkspaceBindingRepository;
    chatSessionRepo: ChatSessionRepository;
    workspaceService: WorkspaceService;
    chatSessionService: ChatSessionService;
    titleGenerator: TitleGeneratorService;
    promptDispatcher: PromptDispatcher;
    cleanupHandler: CleanupCommandHandler;
    topicManager: TelegramTopicManager;
    resolveWorkspaceAndCdp: (ch: any) => Promise<any>;
    setupWorkspaceDetectors: (cdp: any, projectName: string, channel: any) => void;
    queryWorkspacePath: (wsUrl: string) => Promise<any>;
    scanActiveWindows: () => Promise<any>;
    switchWorkspaceInternal: (ctx: Context, workspacePath: string, silent?: boolean) => Promise<any>;
}

// Helper to build TelegramChannel from context
const getChannel = (ctx: Context) => ({
    chatId: ctx.chat!.id,
    threadId: ctx.message?.message_thread_id ?? undefined,
});

const getChannelFromCb = (ctx: Context) => ({
    chatId: ctx.chat!.id,
    threadId: ctx.callbackQuery?.message?.message_thread_id ?? undefined,
});

const replyHtml = async (ctx: Context, text: string, keyboard?: InlineKeyboard) => {
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
    });
};

const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export function registerCallbacks(bot: Bot, deps: CallbackDependencies) {
    const {
        config,
        bridge,
        modeService,
        modelService,
        templateRepo,
        workspaceBindingRepo,
        chatSessionRepo,
        workspaceService,
        chatSessionService,
        titleGenerator,
        promptDispatcher,
        cleanupHandler,
        topicManager,
        resolveWorkspaceAndCdp,
        setupWorkspaceDetectors,
        queryWorkspacePath,
        scanActiveWindows,
        switchWorkspaceInternal,
    } = deps;

    bot.on('callback_query:data', async (ctx) => {
        const data = ctx.callbackQuery.data;
        const ch = getChannelFromCb(ctx);

        // Stop generation button click
        if (data === 'stop_generation') {
            const resolved = await resolveWorkspaceAndCdp(ch);
            const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
            if (!cdp) {
                await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' });
                return;
            }
            try {
                // Clear the Stop button immediately to avoid double clicks
                try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[stop:markup] Failed to clear markup:', e); }

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
            return;
        }

        // Undo last message button click
        if (data === 'undo_last') {
            const resolved = await resolveWorkspaceAndCdp(ch);
            const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
            if (!cdp) {
                await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' });
                return;
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
            return;
        }

        // Mode selection
        if (data.startsWith('mode_select:')) {
            const selectedMode = data.replace('mode_select:', '');
            modeService.setMode(selectedMode);
            const cdp = getCurrentCdp(bridge);
            if (cdp) { const res = await cdp.setUiMode(selectedMode); if (!res.ok) logger.warn(`[Mode] UI switch failed: ${res.error}`); }
            const { text, keyboard } = await buildModeUI(modeService, { getCurrentCdp: () => getCurrentCdp(bridge) });
            try {
                await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
            } catch (e) { logger.debug('[modeSelect] editMessageText failed (expected if unchanged):', e); }
            await ctx.answerCallbackQuery({ text: `Mode: ${MODE_DISPLAY_NAMES[selectedMode] || selectedMode}` });
            return;
        }

        // Exhausted model button — show alert toast
        if (data.startsWith('model_exhausted_')) {
            const modelName = data.replace('model_exhausted_', '');
            await ctx.answerCallbackQuery({ text: `⛔ ${modelName} is exhausted. Wait for quota reset or pick another model.`, show_alert: true });
            return;
        }

        // Model selection
        if (data.startsWith('model_btn_')) {
            const modelName = data.replace('model_btn_', '');
            const cdp = getCurrentCdp(bridge);
            if (!cdp) { await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' }); return; }
            const res = await cdp.setUiModel(modelName);
            if (res.ok) {
                const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                if (payload) try { await ctx.editMessageText(payload.text, { parse_mode: 'HTML', reply_markup: payload.keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: `Model: ${res.model}` });
            } else {
                await ctx.answerCallbackQuery({ text: res.error || 'Failed to change model.' });
            }
            return;
        }

        // Model refresh
        if (data === 'model_refresh_btn') {
            const cdp = getCurrentCdp(bridge);
            if (!cdp) { await ctx.answerCallbackQuery({ text: 'Not connected.' }); return; }
            const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
            if (payload) try { await ctx.editMessageText(payload.text, { parse_mode: 'HTML', reply_markup: payload.keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: 'Refreshed' });
            return;
        }

        // Auto-accept Master toggle
        if (data === AUTOACCEPT_TOGGLE_MASTER) {
            bridge.autoAccept.toggleMaster(!bridge.autoAccept.isEnabled());
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
                bridge.autoAccept,
            );
            await ctx.answerCallbackQuery({ text: t('Auto-accept status updated') });
            return;
        }

        // Auto-accept Category toggle
        if (data.startsWith(AUTOACCEPT_TOGGLE_CAT_PREFIX)) {
            const cat = data.substring(AUTOACCEPT_TOGGLE_CAT_PREFIX.length) as keyof Omit<AutoAcceptSettings, 'enabled'>;
            const s = bridge.autoAccept.getSettings();
            bridge.autoAccept.toggleCategory(cat, !s[cat]);
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
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
            return;
        }

        // Auto-accept bulk actions
        if (data === AUTOACCEPT_ALL_ON) {
            bridge.autoAccept.toggleMaster(true);
            bridge.autoAccept.toggleCategory('fileEdits', true);
            bridge.autoAccept.toggleCategory('consoleCommands', true);
            bridge.autoAccept.toggleCategory('readAccess', true);
            bridge.autoAccept.toggleCategory('urlAccess', true);
            bridge.autoAccept.toggleCategory('otherRequests', true);
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
                bridge.autoAccept,
            );
            await ctx.answerCallbackQuery({ text: t('All categories enabled') });
            return;
        }

        if (data === AUTOACCEPT_ALL_OFF) {
            bridge.autoAccept.toggleMaster(false);
            bridge.autoAccept.toggleCategory('fileEdits', false);
            bridge.autoAccept.toggleCategory('consoleCommands', false);
            bridge.autoAccept.toggleCategory('readAccess', false);
            bridge.autoAccept.toggleCategory('urlAccess', false);
            bridge.autoAccept.toggleCategory('otherRequests', false);
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
                bridge.autoAccept,
            );
            await ctx.answerCallbackQuery({ text: t('All categories disabled') });
            return;
        }

        if (data === AUTOACCEPT_BTN_REFRESH) {
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
                bridge.autoAccept,
            );
            await ctx.answerCallbackQuery({ text: t('Refreshed') });
            return;
        }

        // Mirror mode callbacks
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
            return;
        }

    const selectAndConnectWorkspace = async (
        ctx: Context,
        ch: ChannelContext,
        workspacePath: string,
        cleanFolderName: string,
        fullPath: string,
        key: string,
        guildId: string,
        openInNewWindow: boolean = false,
        targetPort?: number
    ) => {
        promptSelectionSentChannels.delete(key);
        const isForum = ctx.chat?.type === 'supergroup' && (ctx.chat as any).is_forum === true;

        if (config.useTopics && isForum && !ch.threadId) {
            try {
                const existing = workspaceBindingRepo.findByWorkspacePathAndGuildId(workspacePath, guildId);
                const existingTopic = existing.find(b => b.channelId.includes(':'));

                let topicId: number;
                if (existingTopic) {
                    topicId = Number(existingTopic.channelId.split(':')[1]);
                    topicManager.registerTopic(workspacePath, topicId);
                } else {
                    topicManager.setChatId(ch.chatId);
                    const sanitized = topicManager.sanitizeName(cleanFolderName);
                    const result = await topicManager.ensureTopic(sanitized);
                    topicId = result.topicId;
                }

                const topicKey = `${ch.chatId}:${topicId}`;

                await bot.api.sendMessage(
                    ch.chatId,
                    `<b>💼 Workspace Selected</b>\n\n✅ <b>${escapeHtml(cleanFolderName)}</b>\n<code>${escapeHtml(fullPath)}</code>\n\nSend messages here to interact with this workspace.`,
                    { parse_mode: 'HTML', message_thread_id: topicId },
                );
                workspaceBindingRepo.upsert({ channelId: topicKey, workspacePath, guildId });
                bridge.pool.getOrConnect(fullPath, openInNewWindow, targetPort).catch((err: any) => {
                    logger.warn(`[WorkspaceSelectTopic] Proactive connection failed for ${workspacePath}:`, err?.message || err);
                });
                return;
            } catch (e: any) {
                logger.warn(`[WorkspaceSelect] Topic creation failed, falling back: ${e.message}`);
            }
        }

        workspaceBindingRepo.upsert({ channelId: key, workspacePath, guildId });

        bridge.pool.getOrConnect(fullPath, openInNewWindow, targetPort).catch((err: any) => {
            logger.warn(`[WorkspaceSelect] Proactive connection failed for ${workspacePath}:`, err?.message || err);
        });

        const text = `<b>💼 Workspace Selected</b>\n\n✅ <b>${escapeHtml(cleanFolderName)}</b>\n<code>${escapeHtml(fullPath)}</code>\n\nSend messages here to interact with this workspace.`;
        if (ctx.callbackQuery) {
            try {
                await ctx.editMessageText(text, { parse_mode: 'HTML' });
            } catch {
                await replyHtml(ctx, text);
            }
        } else {
            await replyHtml(ctx, text);
        }
    };

    // Project selection
    if (data.startsWith(`${PROJECT_SELECT_ID}:`)) {
        const shortId = data.replace(`${PROJECT_SELECT_ID}:`, '');
        let workspacePath = projectPathCache.get(shortId);
        if (!workspacePath) {
            const workspaces = workspaceService.getRecentWorkspaces().map(w => w.path);
            if (shortId.startsWith('p')) {
                const idx = parseInt(shortId.slice(1), 10);
                if (!isNaN(idx) && idx >= 0 && idx < workspaces.length) {
                    workspacePath = workspaces[idx];
                }
            }
            if (!workspacePath) {
                workspacePath = shortId;
            }
        }

        if (!workspaceService.exists(workspacePath)) {
            await ctx.answerCallbackQuery({ text: `Workspace "${workspacePath}" not found.` });
            return;
        }

        const folderName = path.basename(workspacePath);
        const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
        const fullPath = workspaceService.getWorkspacePath(workspacePath);

        // 1. Scan active windows
        const activeWindows = await scanActiveWindows();

        // 2. Check if this workspace is already open in one of the windows
        const openWindow = activeWindows.find((win: any) => {
            if (win.workspacePath) {
                return path.resolve(win.workspacePath) === path.resolve(fullPath);
            }
            return win.projectName.toLowerCase() === cleanFolderName.toLowerCase();
        });

        const key = channelKey(ch);
        const guildId = String(ch.chatId);

        if (openWindow) {
            // Already open in some window, just select it
            await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, false, undefined);
            await ctx.answerCallbackQuery({ text: `Connected to open window: ${cleanFolderName}` });
            return;
        }

        // 3. Not open. If no windows are open, just launch a new one.
        if (activeWindows.length === 0) {
            await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, false, undefined);
            await ctx.answerCallbackQuery({ text: `Starting IDE for: ${cleanFolderName}` });
            return;
        }

        // 4. There are active windows but this project is not open. Ask user.
        const keyboard = new InlineKeyboard();
        keyboard.text(`🆕 ${t('Open in new window')}`, `open_workspace_mode:new:${shortId}`);
        keyboard.row();

        for (const win of activeWindows) {
            keyboard.text(`🔄 ${t('Switch window')} (${win.projectName} - Port ${win.port})`, `open_workspace_mode:switch:${win.port}:${shortId}`);
            keyboard.row();
        }

        await ctx.editMessageText(
            `💼 <b>${escapeHtml(cleanFolderName)}</b> ${t('is not open in IDE')}.\n\n` +
            `${t('Active windows detected')}. ${t('Choose how to open it')}:`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
        await ctx.answerCallbackQuery();
        return;
    }


        // Open workspace mode confirmation
        if (data.startsWith('open_workspace_mode:')) {
            const parts = data.split(':');
            const mode = parts[1]; // 'new' or 'switch'
            
            let port: number | undefined;
            let shortId: string;
            
            if (mode === 'switch') {
                port = parseInt(parts[2], 10);
                shortId = parts[3];
            } else {
                shortId = parts[2];
            }

            let workspacePath = projectPathCache.get(shortId);
            if (!workspacePath) {
                const workspaces = workspaceService.getRecentWorkspaces().map(w => w.path);
                if (shortId.startsWith('p')) {
                    const idx = parseInt(shortId.slice(1), 10);
                    if (!isNaN(idx) && idx >= 0 && idx < workspaces.length) {
                        workspacePath = workspaces[idx];
                    }
                }
                if (!workspacePath) {
                    workspacePath = shortId;
                }
            }

            if (!workspaceService.exists(workspacePath)) {
                await ctx.answerCallbackQuery({ text: `Workspace not found.` });
                return;
            }

            const folderName = path.basename(workspacePath);
            const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
            const fullPath = workspaceService.getWorkspacePath(workspacePath);

            const key = channelKey(ch);
            const guildId = String(ch.chatId);

            const openInNewWindow = (mode === 'new');

            await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, openInNewWindow, port);
            await ctx.answerCallbackQuery({ text: `Opening ${cleanFolderName}...` });
            return;
        }

        // Switch window button click
        if (data.startsWith('switch_window:')) {
            const shortId = data.replace('switch_window:', '');
            const workspacePath = statusWindowPathCache.get(shortId);
            if (!workspacePath) {
                await ctx.answerCallbackQuery({ text: 'Workspace path not found in cache.' });
                return;
            }

            if (!workspaceService.exists(workspacePath)) {
                await ctx.answerCallbackQuery({ text: `Workspace "${workspacePath}" not found.` });
                return;
            }

            const folderName = path.basename(workspacePath);
            const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');

            promptSelectionSentChannels.delete(channelKey(ch));
            await switchWorkspaceInternal(ctx, workspacePath, false);
            await ctx.answerCallbackQuery({ text: `Selected: ${cleanFolderName}` });
            return;
        }

        // Restore window button click
        if (data.startsWith('restore_window:')) {
            const shortId = data.replace('restore_window:', '');
            const workspacePath = restoreWindowPathCache.get(shortId);
            if (!workspacePath) {
                await ctx.answerCallbackQuery({ text: 'Restore path not found in cache.' });
                return;
            }

            if (!workspaceService.exists(workspacePath)) {
                await ctx.answerCallbackQuery({ text: `Workspace "${workspacePath}" not found.` });
                return;
            }

            const folderName = path.basename(workspacePath);
            const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
            const fullPath = workspaceService.getWorkspacePath(workspacePath);
            const key = channelKey(ch);
            const guildId = String(ch.chatId);

            promptSelectionSentChannels.delete(key);
            await ctx.answerCallbackQuery({ text: `Restoring ${cleanFolderName}...` });
            await replyHtml(ctx, `🔄 <b>${t('Restoring workspace')}...</b>\nLaunching <b>${cleanFolderName}</b> window.`);
            await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, false, undefined);
            return;
        }

        // Show dialogs in current active window
        if (data === 'current_dialogs') {
            const resolved = await resolveWorkspaceAndCdp(ch);
            if (!resolved.ok) {
                await ctx.answerCallbackQuery({ text: 'Not connected to workspace.' });
                return;
            }

            await ctx.answerCallbackQuery({ text: 'Scanning sessions...' });
            const statusMsg = await ctx.reply('🔍 Scanning sessions in Antigravity...');
            try {
                const sessions = await chatSessionService.listAllSessions(resolved.cdp);
                const { text, keyboard } = buildSessionPickerUI(sessions);
                await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
                await replyHtml(ctx, text, keyboard);
            } catch (e: any) {
                await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
                await ctx.reply(`❌ Failed to list sessions: ${e.message}`);
            }
            return;
        }

        // Show history of active dialog in current active window
        if (data === 'current_history') {
            const resolved = await resolveWorkspaceAndCdp(ch);
            if (!resolved.ok) {
                await ctx.answerCallbackQuery({ text: 'Not connected to workspace.' });
                return;
            }

            await ctx.answerCallbackQuery({ text: 'Retrieving history...' });
            const statusMsg = await ctx.reply('🔍 ' + t('Scanning sessions in Antigravity...'));
            try {
                const history = await chatSessionService.getChatHistory(resolved.cdp, 5);
                await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

                if (history.length === 0) {
                    await replyHtml(ctx, t('No messages found in history.'));
                    return;
                }

                // Construct formatted HTML output
                const formattedTurns = history.map(turn => {
                    if (turn.role === 'user') {
                        return `👤 <b>${t('You')}:</b>\n${escapeHtml(turn.text || '')}`;
                    } else {
                        return `🤖 <b>${t('Assistant')}:</b>\n${htmlToTelegramHtml(turn.html || '')}`;
                    }
                });

                // Join turns and send
                const fullHtml = formattedTurns.join('\n\n---\n\n');
                const chunks = splitTelegramHtml(fullHtml, TELEGRAM_MSG_LIMIT);
                for (const chunk of chunks) {
                    if (chunk.trim()) {
                        await replyHtml(ctx, chunk);
                    }
                }
            } catch (e: any) {
                await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
                await ctx.reply(`❌ Failed to retrieve history: ${e.message}`);
            }
            return;
        }

        // Workspace page navigation
        if (data.startsWith(`${PROJECT_PAGE_PREFIX}:`)) {
            const page = parseProjectPageId(data);
            if (!isNaN(page)) {
                const workspaces = workspaceService.getRecentWorkspaces();
                const { text, keyboard } = buildWorkspaceListUI(workspaces, page);
                try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            }
            await ctx.answerCallbackQuery();
            return;
        }

        // Template button
        if (data.startsWith(TEMPLATE_BTN_PREFIX)) {
            const templateId = parseTemplateButtonId(data);
            if (isNaN(templateId)) { await ctx.answerCallbackQuery({ text: 'Invalid template.' }); return; }
            const template = templateRepo.findById(templateId);
            if (!template) { await ctx.answerCallbackQuery({ text: 'Template not found.' }); return; }

            const resolved = await resolveWorkspaceAndCdp(ch);
            if (!resolved.ok) {
                const cdp = getCurrentCdp(bridge);
                if (!cdp) { await ctx.answerCallbackQuery({ text: 'Not connected.' }); return; }
                promptDispatcher.send({ channel: ch, prompt: template.prompt, cdp, inboundImages: [], options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator } }).catch((e) => logger.error('[template] dispatch failed:', e));
            } else {
                promptDispatcher.send({ channel: ch, prompt: template.prompt, cdp: resolved.cdp, inboundImages: [], options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator } }).catch((e) => logger.error('[template] dispatch failed:', e));
            }
            await ctx.answerCallbackQuery({ text: `Running: ${template.name}` });
            return;
        }

        // Session selection
        if (isSessionSelectId(data)) {
            const buttonId = data.replace(`${SESSION_SELECT_ID}:`, '');
            const selectedTitle = sessionTitleCache.get(buttonId) || buttonId;
            const key = channelKey(ch);
            const binding = workspaceBindingRepo.findByChannelId(key);
            if (!binding) { await ctx.answerCallbackQuery({ text: 'No project bound.' }); return; }
            const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            try {
                const cdp = await bridge.pool.getOrConnect(workspacePath);
                const activateResult = await chatSessionService.activateSessionByTitle(cdp, selectedTitle);
                if (activateResult.ok) {
                    // Update database mapping or create one if it doesn't exist
                    let session = chatSessionRepo.findByChannelId(key);
                    if (!session) {
                        const maxNum = chatSessionRepo.getNextSessionNumber(key);
                        chatSessionRepo.create({
                            channelId: key,
                            categoryId: key,
                            workspacePath: binding.workspacePath,
                            sessionNumber: maxNum,
                            guildId: String(ctx.chat!.id),
                        });
                        session = chatSessionRepo.findByChannelId(key);
                    }
                    if (session) {
                        chatSessionRepo.updateDisplayName(key, selectedTitle);
                    }

                    const projectName = bridge.pool.extractProjectName(workspacePath);
                    if (projectName) {
                        registerApprovalSessionChannel(bridge, projectName, selectedTitle, ch);
                    }

                    await ctx.editMessageText(`<b>🔗 Joined Session</b>\n\n<b>${escapeHtml(selectedTitle)}</b>`, { parse_mode: 'HTML' });
                } else {
                    await ctx.answerCallbackQuery({ text: `Failed: ${activateResult.error}` });
                }
            } catch (e: any) {
                await ctx.answerCallbackQuery({ text: `Error: ${e.message}` });
            }
            return;
        }

        // Approval buttons
        const approvalAction = parseApprovalCustomId(data);
        if (approvalAction) {
            const projectName = approvalAction.projectName ?? bridge.lastActiveWorkspace;
            let detector = projectName ? bridge.pool.getApprovalDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getApprovalDetector(resolved.projectName);
                }
            }
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Approval detector not found.' }); return; }

            let success = false;
            let actionLabel = '';
            if (approvalAction.action === 'approve') { success = await detector.approveButton(); actionLabel = 'Allow'; }
            else if (approvalAction.action === 'always_allow') { success = await detector.alwaysAllowButton(); actionLabel = 'Allow Chat'; }
            else { success = await detector.denyButton(); actionLabel = 'Deny'; }

            if (success) {
                // Do not remove the keyboard optimistically — onResolved() removes it when
                // the DOM buttons actually disappear. This keeps the keyboard visible for
                // retry if the CDP click was dispatched but Antigravity did not act on it.
                await ctx.answerCallbackQuery({ text: `${actionLabel} sent — waiting for IDE response…` });

                const cdp = (projectName ? bridge.pool.getConnected(projectName) : null) ?? getCurrentCdp(bridge);
                if (cdp && !promptDispatcher.isBusy(ch, cdp)) {
                    logger.info(`[ApprovalCallback] Starting passive monitoring for workspace ${projectName}`);
                    const mirrorPromise = mirrorResponseToTelegram(bridge, ch, cdp, `${actionLabel} action`, {
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
                await ctx.answerCallbackQuery({ text: 'Button not found in IDE. Use /allow or /deny to retry.' });
            }
            return;
        }

        // Planning buttons (legacy parsing for backward compat)
        const planningAction = parsePlanningCustomId(data);
        if (planningAction) {
            const projectName = planningAction.projectName ?? bridge.lastActiveWorkspace;
            let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getPlanningDetector(resolved.projectName);
                }
            }
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

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
                if (clicked) try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: clicked ? 'Proceeding...' : 'Proceed button not found.' });
            }
            return;
        }

        // New plan UI buttons (View/Proceed/Edit/Refresh)
        if (data.startsWith(PLAN_VIEW_BTN + ':')) {
            const suffix = data.substring(PLAN_VIEW_BTN.length + 1);
            const [projectName] = suffix.split(':');
            let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getPlanningDetector(resolved.projectName);
                }
            }
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

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
                    await bot.api.sendMessage(ch.chatId, `\u26A0\uFE0F <b>Extraction Failed</b>\n\nThe ${projectName ? escapeHtml(projectName) : 'workspace'} UI was instructed to open the file, but we couldn't extract the text content to show inside Telegram. Please check your IDE.`, { parse_mode: 'HTML', message_thread_id: ch.threadId });
                }
            }
            await ctx.answerCallbackQuery({ text: clicked ? 'Opened' : 'Open button not found.' });
            return;
        }

        if (data.startsWith(PLAN_PROCEED_BTN + ':')) {
            const suffix = data.substring(PLAN_PROCEED_BTN.length + 1);
            const [projectName] = suffix.split(':');
            let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getPlanningDetector(resolved.projectName);
                }
            }
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

            const clicked = await detector.clickProceedButton();
            if (clicked) {
                planEditPendingChannels.delete(channelKey(ch));
                try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            }
            await ctx.answerCallbackQuery({ text: clicked ? 'Proceeding...' : 'Proceed button not found.' });
            return;
        }

        if (data.startsWith(PLAN_EDIT_BTN + ':')) {
            const suffix = data.substring(PLAN_EDIT_BTN.length + 1);
            const [projectName] = suffix.split(':');
            planEditPendingChannels.set(channelKey(ch), { projectName });
            await ctx.answerCallbackQuery({ text: 'Type your edit instructions (or /cancel).' });
            await bot.api.sendMessage(ch.chatId, '<b>Edit Plan</b>\n\nType your plan edit instructions below.\nSend <code>/cancel</code> to cancel.', { parse_mode: 'HTML', message_thread_id: ch.threadId });
            return;
        }

        if (data.startsWith(PLAN_REFRESH_BTN + ':')) {
            const suffix = data.substring(PLAN_REFRESH_BTN.length + 1);
            const [projectName, targetChannelStr] = suffix.split(':');
            let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getPlanningDetector(resolved.projectName);
                }
            }
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

            const info = detector.getLastDetectedInfo();
            if (info) {
                const { text: uiText, buttons: uiButtons } = buildPlanNotificationUI(info, projectName, targetChannelStr || String(ch.chatId));
                const uiKeyboard = buildTelegramKeyboard(uiButtons);
                try { await ctx.editMessageText(uiText, { parse_mode: 'HTML', reply_markup: uiKeyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            }
            await ctx.answerCallbackQuery({ text: 'Refreshed' });
            return;
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
            if (!pages || isNaN(page)) { await ctx.answerCallbackQuery({ text: 'Page not found.' }); return; }

            let detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getPlanningDetector(resolved.projectName);
                }
            }
            const lastInfo = detector?.getLastDetectedInfo();

            const { text: pageText, buttons: pageButtons } = buildPlanContentUI(pages, page, projectName, targetChannelStr || String(ch.chatId), lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
            const pageKeyboard = buildTelegramKeyboard(pageButtons);
            try { await ctx.editMessageText(pageText, { parse_mode: 'HTML', reply_markup: pageKeyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: `Page ${page + 1}/${pages.length}` });
            return;
        }

        // Error popup buttons
        const errorAction = parseErrorPopupCustomId(data);
        if (errorAction) {
            const projectName = errorAction.projectName ?? bridge.lastActiveWorkspace;
            let detector = projectName ? bridge.pool.getErrorPopupDetector(projectName) : undefined;
            if (!detector) {
                const resolved = await resolveWorkspaceAndCdp(ch);
                if (resolved.ok) {
                    detector = bridge.pool.getErrorPopupDetector(resolved.projectName);
                }
            }
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Error popup detector not found.' }); return; }

            if (errorAction.action === 'dismiss') {
                const clicked = await detector.clickDismissButton();
                if (clicked) try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: clicked ? 'Dismissed' : 'Button not found.' });
            } else if (errorAction.action === 'copy_debug') {
                const clicked = await detector.clickCopyDebugInfoButton();
                let clipboardOk = false;
                if (clicked) {
                    await new Promise(r => setTimeout(r, 300));
                    const clipboardContent = await detector.readClipboard();
                    if (clipboardContent) {
                        clipboardOk = true;
                        const truncated = clipboardContent.length > 3800 ? clipboardContent.substring(0, 3800) + '\n(truncated)' : clipboardContent;
                        await bot.api.sendMessage(ch.chatId, `<b>Debug Info</b>\n\n<pre>${escapeHtml(truncated)}</pre>`, { parse_mode: 'HTML', message_thread_id: ch.threadId });
                    }
                }
                const feedbackText = !clicked ? 'Button not found.' : clipboardOk ? 'Copied' : 'Could not read clipboard.';
                await ctx.answerCallbackQuery({ text: feedbackText });
            } else {
                const clicked = await detector.clickRetryButton();
                if (clicked) try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: clicked ? 'Retrying...' : 'Button not found.' });
            }
            return;
        }

        // Interrupt buttons (Queue / Send Now / Discard)
        if (data.startsWith(INTERRUPT_QUEUE_PREFIX) || data.startsWith(INTERRUPT_NOW_PREFIX) || data.startsWith(INTERRUPT_DISCARD_PREFIX)) {
            const targetKey = data.startsWith(INTERRUPT_QUEUE_PREFIX)
                ? data.slice(INTERRUPT_QUEUE_PREFIX.length)
                : data.startsWith(INTERRUPT_NOW_PREFIX)
                    ? data.slice(INTERRUPT_NOW_PREFIX.length)
                    : data.slice(INTERRUPT_DISCARD_PREFIX.length);

            if (data.startsWith(INTERRUPT_DISCARD_PREFIX)) {
                // Discard the first pending interrupt and clean up any attached images
                const discarded = shiftPendingInterrupt(targetKey);
                if (discarded?.inboundImages?.length) {
                    cleanupInboundImageAttachments(discarded.inboundImages).catch(() => {});
                }
                try { await ctx.editMessageText('🗑 Message discarded.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
                await ctx.answerCallbackQuery({ text: 'Discarded' });
                return;
            }

            const pending = shiftPendingInterrupt(targetKey);
            if (!pending) {
                try { await ctx.editMessageText('✅ Task finished — your message was already processed.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
                await ctx.answerCallbackQuery({ text: 'Already processed' });
                return;
            }

            // Re-resolve CDP from pool to avoid dispatching with a stale reference.
            // For the stop-button click we still use pending.cdp (it targets the running session).
            const projectName = targetKey.startsWith('ws:') ? targetKey.slice(3) : null;
            const freshCdp = projectName ? bridge.pool.getConnected(projectName) : null;

            if (data.startsWith(INTERRUPT_NOW_PREFIX)) {
                // Stop current generation, then send the new prompt
                try { await ctx.editMessageText('⚡ Stopping current task and sending your message…'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
                await ctx.answerCallbackQuery({ text: 'Stopping & sending...' });

                // Click the stop button in Antigravity (use pending.cdp — it targets the running session)
                try {
                    const contextId = pending.cdp.getPrimaryContextId();
                    const callParams: Record<string, unknown> = { expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON, returnByValue: true, awaitPromise: false };
                    if (contextId !== null) callParams.contextId = contextId;
                    await pending.cdp.call('Runtime.evaluate', callParams);
                    userStopRequestedChannels.add(channelKey(pending.channel));
                } catch (e) { logger.debug('[interrupt:now] Stop button click failed:', e); }

                const dispatchCdp = freshCdp ?? pending.cdp;
                promptDispatcher.send({
                    channel: pending.channel,
                    prompt: pending.prompt,
                    cdp: dispatchCdp,
                    inboundImages: pending.inboundImages,
                    options: pending.options,
                }).catch((e) => { logger.error('[interrupt:now] dispatch failed:', e); });
                return;
            }

            // INTERRUPT_QUEUE_PREFIX — queue to run after current task finishes
            try { await ctx.editMessageText('📥 Message queued — will send after current task.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
            await ctx.answerCallbackQuery({ text: 'Queued' });

            const dispatchCdp = freshCdp ?? pending.cdp;
            promptDispatcher.send({
                channel: pending.channel,
                prompt: pending.prompt,
                cdp: dispatchCdp,
                inboundImages: pending.inboundImages,
                options: pending.options,
            }).catch((e) => { logger.error('[interrupt:queue] dispatch failed:', e); });
            return;
        }

        // Cleanup buttons
        if (data.startsWith(CLEANUP_ARCHIVE_BTN) || data.startsWith(CLEANUP_DELETE_BTN) || data === CLEANUP_CANCEL_BTN || data === CLEANUP_DISK_ORPHANED_BTN || data === CLEANUP_DISK_ALL_INACTIVE_BTN) {
            if (data === CLEANUP_CANCEL_BTN) {
                try { await ctx.editMessageText('Cleanup cancelled.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: 'Cancelled' });
                return;
            }

            if (data === CLEANUP_DISK_ORPHANED_BTN || data === CLEANUP_DISK_ALL_INACTIVE_BTN) {
                const isOrphanedOnly = data === CLEANUP_DISK_ORPHANED_BTN;
                try {
                    await ctx.editMessageText('🧹 Очистка файлов на диске...');
                } catch (_) {}

                const result = isOrphanedOnly 
                    ? cleanupHandler.cleanupOrphanedChats() 
                    : cleanupHandler.cleanupAllInactiveChats();

                const textResult = `🧹 <b>Очистка диска завершена</b>\n\n` +
                    `• Удалено диалогов: <b>${result.processedCount}</b>\n` +
                    `• Освобождено места: <b>${formatBytes(result.freedBytes)}</b>\n` +
                    (result.errors.length > 0 ? `\n⚠️ Ошибки при удалении некоторых файлов:\n${result.errors.join('\n')}` : '');

                try {
                    await ctx.editMessageText(textResult, { parse_mode: 'HTML' });
                } catch (e) {
                    logger.debug('[cleanupDisk] Telegram edit failed:', e);
                }
                await ctx.answerCallbackQuery({ text: `Удалено: ${result.processedCount} чатов` });
                return;
            }

            const isDelete = data.startsWith(CLEANUP_DELETE_BTN);
            const callbackDays = parseInt(data.split(':')[1], 10) || 7;
            const guildId = String(ch.chatId);
            const inactive = cleanupHandler.findInactiveSessions(guildId, callbackDays);

            let processed = 0;
            for (const { binding } of inactive) {
                const threadId = binding.channelId.includes(':')
                    ? Number(binding.channelId.split(':')[1])
                    : undefined;

                if (threadId) {
                    try {
                        if (isDelete) {
                            await bot.api.deleteForumTopic(ch.chatId, threadId);
                        } else {
                            await bot.api.closeForumTopic(ch.chatId, threadId);
                        }
                    } catch (e: any) {
                        logger.warn(`[Cleanup] Topic operation failed for ${binding.channelId}: ${e.message}`);
                    }
                }

                cleanupHandler.cleanupByChannelId(binding.channelId);
                processed++;
            }

            const action = isDelete ? 'deleted' : 'archived';
            try { await ctx.editMessageText(`✅ Cleanup complete — ${processed} session(s) ${action}.`); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: `${processed} session(s) ${action}` });
            return;
        }

        // AI interactive choices callback
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
            return;
        }

        // Mirror all windows settings callback
        if (data.startsWith('mirror_all:')) {
            const action = data.replace('mirror_all:', '');
            const enable = action === 'on';
            ConfigLoader.save({ onlyActiveWorkspaceMessages: !enable });
            const status = enable ? '🟢 ' + t('ON') : '⚪ ' + t('OFF');
            const keyboard = new InlineKeyboard()
                .text('🟢 ' + t('Turn ON'), 'mirror_all:on')
                .text('⚪ ' + t('Turn OFF'), 'mirror_all:off');
            try {
                await ctx.editMessageText(
                    `<b>⚙️ ${t('Mirror All Windows Settings')}</b>\n\n` +
                    `${t('Current status:')} <b>${status}</b>\n\n` +
                    `${t('When enabled, messages and progress from all open IDE windows will be mirrored.')}\n` +
                    `${t('When disabled, messages will only be mirrored from the currently active workspace in this chat.')}`,
                    { parse_mode: 'HTML', reply_markup: keyboard }
                );
            } catch (e) { logger.debug('[mirror_all] Telegram edit failed:', e); }
            await ctx.answerCallbackQuery({ text: `${t('Mirror all windows')}: ${action.toUpperCase()}` });
            return;
        }


        await ctx.answerCallbackQuery();
    });
}
