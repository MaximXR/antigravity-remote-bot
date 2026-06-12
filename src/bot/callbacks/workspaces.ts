import { Context, Bot } from 'grammy';
import path from 'path';
import { CallbackDependencies } from '../callbacks';
import {
    PROJECT_SELECT_ID,
    PROJECT_PAGE_PREFIX,
    parseProjectPageId,
    projectPathCache,
    buildWorkspaceListUI,
} from '../../ui/projectListUi';
import {
    statusWindowPathCache,
    restoreWindowPathCache,
    promptSelectionSentChannels,
} from '../botState';
import {
    registerApprovalWorkspaceChannel,
} from '../../services/cdpBridgeManager';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { escapeHtml } from '../../utils/telegramFormatter';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

async function selectAndConnectWorkspace(
    ctx: Context,
    ch: any,
    workspacePath: string,
    cleanFolderName: string,
    fullPath: string,
    key: string,
    guildId: string,
    openInNewWindow: boolean = false,
    targetPort: number | undefined,
    deps: CallbackDependencies,
    bot: Bot
) {
    const { config, workspaceBindingRepo, bridge, topicManager } = deps;
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
            await ctx.reply(text, { parse_mode: 'HTML' });
        }
    } else {
        await ctx.reply(text, { parse_mode: 'HTML' });
    }
}

export async function handleWorkspaces(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const {
        workspaceService,
        scanActiveWindows,
        switchWorkspaceInternal,
        workspaceBindingRepo,
        bridge,
    } = deps;

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
            return true;
        }

        const folderName = path.basename(workspacePath);
        const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
        const fullPath = workspaceService.getWorkspacePath(workspacePath);

        const activeWindows = await scanActiveWindows();
        const openWindow = activeWindows.find((win: any) => {
            if (win.workspacePath) {
                return path.resolve(win.workspacePath) === path.resolve(fullPath);
            }
            return win.projectName.toLowerCase() === cleanFolderName.toLowerCase();
        });

        const key = channelKey(ch);
        const guildId = String(ch.chatId);

        if (openWindow) {
            await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, false, undefined, deps, bot);
            await ctx.answerCallbackQuery({ text: `Connected to open window: ${cleanFolderName}` });
            return true;
        }

        if (activeWindows.length === 0) {
            await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, false, undefined, deps, bot);
            await ctx.answerCallbackQuery({ text: `Starting IDE for: ${cleanFolderName}` });
            return true;
        }

        const keyboard = bot.api ? new (require('grammy').InlineKeyboard)() : null;
        if (keyboard) {
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
        }
        await ctx.answerCallbackQuery();
        return true;
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
            return true;
        }

        const folderName = path.basename(workspacePath);
        const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
        const fullPath = workspaceService.getWorkspacePath(workspacePath);

        const key = channelKey(ch);
        const guildId = String(ch.chatId);
        const openInNewWindow = (mode === 'new');

        await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, openInNewWindow, port, deps, bot);
        await ctx.answerCallbackQuery({ text: `Opening ${cleanFolderName}...` });
        return true;
    }

    // Switch window button click
    if (data.startsWith('switch_window:')) {
        const shortId = data.replace('switch_window:', '');
        const workspacePath = statusWindowPathCache.get(shortId);
        if (!workspacePath) {
            await ctx.answerCallbackQuery({ text: 'Workspace path not found in cache.' });
            return true;
        }

        if (!workspaceService.exists(workspacePath)) {
            await ctx.answerCallbackQuery({ text: `Workspace "${workspacePath}" not found.` });
            return true;
        }

        const folderName = path.basename(workspacePath);
        const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');

        promptSelectionSentChannels.delete(channelKey(ch));
        await switchWorkspaceInternal(ctx, workspacePath, false);
        await ctx.answerCallbackQuery({ text: `Selected: ${cleanFolderName}` });
        return true;
    }

    // Restore window button click
    if (data.startsWith('restore_window:')) {
        const shortId = data.replace('restore_window:', '');
        const workspacePath = restoreWindowPathCache.get(shortId);
        if (!workspacePath) {
            await ctx.answerCallbackQuery({ text: 'Restore path not found in cache.' });
            return true;
        }

        if (!workspaceService.exists(workspacePath)) {
            await ctx.answerCallbackQuery({ text: `Workspace "${workspacePath}" not found.` });
            return true;
        }

        const folderName = path.basename(workspacePath);
        const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
        const fullPath = workspaceService.getWorkspacePath(workspacePath);
        const key = channelKey(ch);
        const guildId = String(ch.chatId);

        promptSelectionSentChannels.delete(key);
        await ctx.answerCallbackQuery({ text: `Restoring ${cleanFolderName}...` });
        await ctx.reply(`🔄 <b>${t('Restoring workspace')}...</b>\nLaunching <b>${cleanFolderName}</b> window.`, { parse_mode: 'HTML' });
        await selectAndConnectWorkspace(ctx, ch, workspacePath, cleanFolderName, fullPath, key, guildId, false, undefined, deps, bot);
        return true;
    }

    // Workspace page navigation
    if (data.startsWith(`${PROJECT_PAGE_PREFIX}:`)) {
        const page = parseProjectPageId(data);
        if (!isNaN(page)) {
            const workspaces = workspaceService.getRecentWorkspaces();
            const { text, keyboard } = buildWorkspaceListUI(workspaces, page);
            try {
                await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
            }
        }
        await ctx.answerCallbackQuery();
        return true;
    }

    return false;
}
