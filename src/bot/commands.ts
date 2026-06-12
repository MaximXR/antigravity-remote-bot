import { Bot, Context, InlineKeyboard } from 'grammy';
import Database from 'better-sqlite3';
import path from 'path';
import WebSocket from 'ws';
// @ts-ignore
import fetch from 'node-fetch';
import * as fs from 'fs';

import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { ConfigLoader } from '../utils/configLoader';
import { loadConfig } from '../utils/config';
import { escapeHtml, splitTelegramHtml } from '../utils/telegramFormatter';
import { htmlToTelegramHtml } from '../utils/htmlToTelegramMarkdown';
import { sendModeUI } from '../ui/modeUi';
import { sendModelsUI } from '../ui/modelsUi';
import { sendTemplateUI } from '../ui/templateUi';
import { sendAutoAcceptUI } from '../ui/autoAcceptUi';
import { handleScreenshot } from '../ui/screenshotUi';
import { buildWorkspaceListUI } from '../ui/projectListUi';
import { buildSessionPickerUI } from '../ui/sessionPickerUi';
import { RESPONSE_SELECTORS } from '../utils/domSelectors';
import { getCurrentCdp } from '../services/cdpBridgeManager';
import { channelKeyFromChannel } from '../services/workspaceResolver';
import { getWorkspaceDisplayPath } from '../utils/pathUtils';

import {
    CLEANUP_ARCHIVE_BTN,
    CLEANUP_DELETE_BTN,
    CLEANUP_CANCEL_BTN,
    CLEANUP_DISK_ORPHANED_BTN,
    CLEANUP_DISK_ALL_INACTIVE_BTN,
} from '../commands/cleanupCommandHandler';

import {
    userStopRequestedChannels,
    statusWindowPathCache,
    restoreWindowPathCache,
    promptSelectionSentChannels,
} from './botState';

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
import { CdpBridge } from '../services/cdpBridgeManager';

const channelKey = channelKeyFromChannel;
const TELEGRAM_MSG_LIMIT = 4096;

export interface CommandDependencies {
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
    slashCommandHandler: SlashCommandHandler;
    cleanupHandler: CleanupCommandHandler;
    topicManager: TelegramTopicManager;
    resolveWorkspaceAndCdp: (ch: any) => Promise<any>;
    setupWorkspaceDetectors: (cdp: any, projectName: string, channel: any) => void;
    queryWorkspacePath: (wsUrl: string, title?: string) => Promise<any>;
    scanActiveWindows: () => Promise<any>;
    switchWorkspaceInternal: (ctx: Context, workspacePath: string, silent?: boolean) => Promise<any>;
}

// Helper to build TelegramChannel from context
const getChannel = (ctx: Context) => ({
    chatId: ctx.chat!.id,
    threadId: ctx.message?.message_thread_id ?? undefined,
});

const replyHtml = async (ctx: Context, text: string, keyboard?: InlineKeyboard) => {
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
    });
};

// Helper to format bytes
const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export function registerCommands(bot: Bot, deps: CommandDependencies) {
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
        slashCommandHandler,
        cleanupHandler,
        topicManager,
        resolveWorkspaceAndCdp,
        scanActiveWindows,
        switchWorkspaceInternal,
    } = deps;

    // /start command
    bot.command('start', async (ctx) => {
        await replyHtml(ctx,
            `<b>Remoat Online</b>\n\n` +
            t('Use /help for available commands.') + `\n` +
            t('Send any text message to forward it to Antigravity.')
        );
    });

    // /help command
    bot.command('help', async (ctx) => {
        await replyHtml(ctx,
            `<b>📖 ` + t('Remoat Commands') + `</b>\n\n` +
            `<b>💬 ` + t('Chat') + `</b>\n` +
            `/new — ` + t('Start a new chat session') + `\n` +
            `/chat — ` + t('Current session info') + `\n` +
            `/chats — ` + t('List and select chats') + `\n` +
            `/history — ` + t('Load history of the active session') + `\n\n` +
            `<b>⏹️ ` + t('Control') + `</b>\n` +
            `/stop — ` + t('Interrupt active generation') + `\n` +
            `/screenshot — ` + t('Capture Antigravity screen') + `\n` +
            `/close — ` + t('Terminate active Antigravity session') + `\n\n` +
            `<b>⚙️ ` + t('Settings') + `</b>\n` +
            `/mode — ` + t('Change execution mode') + `\n` +
            `/model — ` + t('Change LLM model') + `\n` +
            `/mirror — ` + t('Set Mirror Mode') + `\n` +
            `/autoaccept — ` + t('Toggle auto-approve mode') + `\n\n` +
            `<b>💼 ` + t('Workspaces') + `</b>\n` +
            `/workspace — ` + t('Select a workspace') + `\n` +
            `/setworkspacedir — ` + t('Change workspace base directory') + `\n\n` +
            `<b>📝 ` + t('Templates') + `</b>\n` +
            `/template — ` + t('Show templates') + `\n` +
            `/template_add — ` + t('Register a template') + `\n` +
            `/template_delete — ` + t('Delete a template') + `\n\n` +
            `<b>🔧 ` + t('System') + `</b>\n` +
            `/status — ` + t('Bot status overview') + `\n` +
            `/cleanup — ` + t('Clean up inactive sessions') + `\n` +
            `/ping — ` + t('Check latency') + `\n\n` +
            `<i>` + t('Text messages are sent directly to Antigravity') + `</i>`
        );
    });

    // /mode command
    bot.command('mode', async (ctx) => {
        await sendModeUI(
            async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
            modeService,
            { getCurrentCdp: () => getCurrentCdp(bridge) },
        );
    });

    // /model command
    bot.command('model', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const getCdp = (): CdpService | null => (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
        const modelName = ctx.match?.trim();
        if (modelName) {
            const cdp = getCdp();
            if (!cdp) { await ctx.reply('Not connected to CDP. Send a message first to connect.'); return; }
            const res = await cdp.setUiModel(modelName);
            if (res.ok) { await ctx.reply(`Model changed to <b>${escapeHtml(res.model || modelName)}</b>.`, { parse_mode: 'HTML' }); }
            else { await ctx.reply(res.error || 'Failed to change model.'); }
        } else {
            await sendModelsUI(
                async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
                { getCurrentCdp: getCdp, fetchQuota: async () => bridge.quota.fetchQuota() },
            );
        }
    });

    // /template command
    bot.command('template', async (ctx) => {
        const templates = templateRepo.findAll();
        await sendTemplateUI(
            async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
            templates,
        );
    });

    // /template_add command
    bot.command('template_add', async (ctx) => {
        const args = (ctx.match || '').trim();
        const parts = args.split(/\s+/);
        if (parts.length < 2) {
            await ctx.reply('Usage: /template_add <name> <prompt>');
            return;
        }
        const name = parts[0];
        const prompt = parts.slice(1).join(' ');
        const result = await slashCommandHandler.handleCommand('template', ['add', name, prompt]);
        await ctx.reply(result.message);
    });

    // /template_delete command
    bot.command('template_delete', async (ctx) => {
        const name = (ctx.match || '').trim();
        if (!name) { await ctx.reply('Usage: /template_delete <name>'); return; }
        const result = await slashCommandHandler.handleCommand('template', ['delete', name]);
        await ctx.reply(result.message);
    });

    // /setworkspacedir command
    bot.command('setworkspacedir', async (ctx) => {
        const newPath = (ctx.match || '').trim();
        if (!newPath) {
            await ctx.reply(`Usage: /setworkspacedir <path>\nCurrent base directory: ${workspaceService.getBaseDir()}`);
            return;
        }

        try {
            workspaceService.setBaseDir(newPath);
            ConfigLoader.save({ workspaceBaseDir: newPath });
            await ctx.reply(`✅ Workspace base directory updated to:\n<code>${newPath}</code>`, { parse_mode: 'HTML' });
        } catch (e: any) {
            await ctx.reply(`⚠️ Failed to update workspace base directory: ${e.message}`);
        }
    });

    // Handle /status command
    const handleStatus = async (ctx: Context) => {
        const conf = loadConfig();
        const currentMode = modeService.getCurrentMode();
        
        // Detailed auto accept status
        const s = bridge.autoAccept.getSettings();
        let autoAcceptStatus = '';
        if (!s.enabled) {
            autoAcceptStatus = `⚪ ${t('OFF')}`;
        } else {
            const activeCats: string[] = [];
            if (s.fileEdits) activeCats.push(t('File Edits'));
            if (s.consoleCommands) activeCats.push(t('Console'));
            if (s.readAccess) activeCats.push(t('Read'));
            if (s.urlAccess) activeCats.push(t('URL'));
            if (s.otherRequests) activeCats.push(t('Other'));

            if (activeCats.length === 5) {
                autoAcceptStatus = `🟢 ${t('ON')} (${t('all')})`;
            } else if (activeCats.length > 0) {
                autoAcceptStatus = `🟢 ${t('ON')} (${activeCats.join(', ')})`;
            } else {
                autoAcceptStatus = `🟢 ${t('ON')} (${t('(None)')})`;
            }
        }

        const mirrorMode = conf.mirrorMode || (conf.onlyActiveWorkspaceMessages ? 'active' : 'all');
        const mirrorModeText = t(mirrorMode);

        let text = `<b>🔧 ${t('Bot Status')}</b>\n\n`;
        text += `<b>${t('Mode')}:</b> ${escapeHtml(t(MODE_DISPLAY_NAMES[currentMode] || currentMode))}\n`;
        text += `<b>${t('Auto Approve')}:</b> ${autoAcceptStatus}\n`;
        text += `<b>${t('Mirror Mode')}:</b> 🖥️ ${escapeHtml(mirrorModeText)}\n\n`;

        const activeWindows = await scanActiveWindows();

        // Get bound workspace for CURRENT chat
        const ch = getChannel(ctx);
        const binding = workspaceBindingRepo.findByChannelId(channelKey(ch));
        if (binding) {
            const isEmp = binding.workspacePath.startsWith('empty-workspace:');
            const matchingWin = activeWindows.find((win: any) => win.workspacePath && win.workspacePath.toLowerCase() === binding.workspacePath.toLowerCase());
            const cleanFolderName = matchingWin ? matchingWin.projectName : (isEmp ? 'Antigravity (без папки)' : path.basename(binding.workspacePath).replace(/\.code-workspace$/i, ''));
            text += `<b>${t('Current Workspace (this chat)')}:</b> 📂 <b>${escapeHtml(cleanFolderName)}</b>\n`;
            if (isEmp) {
                text += `  <i>${t('Path unknown')}</i>\n\n`;
            } else {
                text += `  <code>${escapeHtml(getWorkspaceDisplayPath(binding.workspacePath))}</code>\n`;
                if (!matchingWin) {
                    text += `  <b>${escapeHtml(t('⚠️ This workspace is currently closed or not running in the IDE!'))}</b>\n`;
                }
                text += '\n';
            }
        } else {
            text += `<b>${t('Current Workspace (this chat)')}:</b> ⚪ ${t('None')}\n\n`;
        }

        // Proactively connect to any newly discovered open windows in the background
        activeWindows.forEach((win: any) => {
            if (win.workspacePath && !bridge.pool.getConnectedByWebSocketUrl(win.webSocketDebuggerUrl)) {
                bridge.pool.getOrConnect(win.workspacePath).then((cdp) => {
                    deps.setupWorkspaceDetectors(cdp, win.projectName, ch);
                    logger.info(`[status] Proactively connected to open window: ${win.projectName}`);
                }).catch((err) => {
                    logger.debug(`[status] Failed proactive connection to open window ${win.projectName}:`, err?.message || err);
                });
            }
        });

        // Fetch session info ONLY for already connected windows to avoid CDP connection lag/hangs
        const activeWindowsWithSessions = await Promise.all(
            activeWindows.map(async (win: any) => {
                let sessionInfo = win.sessionInfo || null;
                if (!sessionInfo) {
                    try {
                        const cdp = bridge.pool.getConnectedByWebSocketUrl(win.webSocketDebuggerUrl);
                        if (cdp) {
                            sessionInfo = await chatSessionService.getCurrentSessionInfo(cdp);
                        }
                    } catch (e) {
                        logger.debug(`[handleStatus] Failed to get session info for ${win.projectName}:`, e);
                    }
                }
                return { ...win, sessionInfo };
            })
        );

        if (activeWindowsWithSessions.length > 0) {
            text += `<b>${t('Open IDE Windows')}:</b>\n`;
            for (const win of activeWindowsWithSessions) {
                const isEmp = win.workspacePath && win.workspacePath.startsWith('empty-workspace:');
                const pathStr = win.workspacePath && !isEmp ? `<code>${escapeHtml(getWorkspaceDisplayPath(win.workspacePath))}</code>` : `<i>${t('Path unknown')}</i>`;
                let sessionStr = '';
                if (win.sessionInfo) {
                    sessionStr = `\n  Active Chat: 💬 <b>${escapeHtml(win.sessionInfo.title)}</b>`;
                } else {
                    sessionStr = `\n  Active Chat: <i>${t('Unknown')}</i>`;
                }
                const isActive = !!(binding && win.workspacePath &&
                    (path.resolve(win.workspacePath).toLowerCase() === path.resolve(binding.workspacePath).toLowerCase()));
                const prefix = isActive ? '⭐🖥️' : '🖥️';
                text += `${prefix} <b>${escapeHtml(win.projectName)}</b> (Port ${win.port})\n  Title: <i>${escapeHtml(win.title)}</i>\n  Path: ${pathStr}${sessionStr}\n`;
            }
        } else {
            text += `<b>${t('Open IDE Windows')}:</b> ⚪ ${t('None detected')}\n`;
        }

        text += `\nUse /chats or /history to manage sessions.`;

        // Build inline keyboard to switch to open windows
        const keyboard = new InlineKeyboard();
        let buttonCount = 0;

        for (const win of activeWindowsWithSessions) {
            if (win.workspacePath) {
                const cleanName = win.projectName.replace(/\.code-workspace$/i, '');
                const shortId = `sw_${buttonCount++}`;
                statusWindowPathCache.set(shortId, win.workspacePath);

                // Add simple connect button with length limiting (max 42 chars)
                let buttonText = `🔌 ${cleanName}`;
                if (buttonText.length > 42) {
                    buttonText = buttonText.slice(0, 39) + '...';
                }
                keyboard.text(buttonText, `switch_window:${shortId}`).row();
            }
        }

        if (buttonCount > 0) {
            text += `\n\n<i>${t('Click buttons below to switch this chat to any open window:')}</i>`;
            await replyHtml(ctx, text, keyboard);
        } else {
            await replyHtml(ctx, text);
        }
    };

    bot.command('status', handleStatus);

    // /autoaccept command
    bot.command('autoaccept', async (ctx) => {
        const requestedMode = (ctx.match || '').trim().toLowerCase();
        if (requestedMode === 'on' || requestedMode === 'enable' || requestedMode === 'true') {
            bridge.autoAccept.toggleMaster(true);
            await ctx.reply(t('✅ Auto-accept mode turned **ON**. Future dialogs will be auto-allowed.'));
        } else if (requestedMode === 'off' || requestedMode === 'disable' || requestedMode === 'false') {
            bridge.autoAccept.toggleMaster(false);
            await ctx.reply(t('✅ Auto-accept mode turned **OFF**. Returned to manual approval.'));
        } else {
            await sendAutoAcceptUI(
                async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
                bridge.autoAccept,
            );
        }
    });

    const handleMirrorCommand = async (ctx: Context) => {
        const matchVal = ctx.match;
        const arg = (typeof matchVal === 'string' ? matchVal : (Array.isArray(matchVal) ? matchVal[0] : '')).trim().toLowerCase();
        if (arg === 'all' || arg === 'on' || arg === 'true' || arg === 'yes' || arg === '1') {
            ConfigLoader.save({ mirrorMode: 'all', onlyActiveWorkspaceMessages: false });
            await ctx.reply(`🟢 <b>${t('Mirror Mode')}: ${t('all')}</b>\n${t('Messages and progress from all open IDE windows will now be mirrored.')}`, { parse_mode: 'HTML' });
            return;
        }
        if (arg === 'active' || arg === 'off' || arg === 'false' || arg === 'no' || arg === '0') {
            ConfigLoader.save({ mirrorMode: 'active', onlyActiveWorkspaceMessages: true });
            await ctx.reply(`⚪ <b>${t('Mirror Mode')}: ${t('active')}</b>\n${t('Messages will now only be mirrored from the selected active workspace.')}`, { parse_mode: 'HTML' });
            return;
        }
        if (arg === 'telegram_only' || arg === 'telegram') {
            ConfigLoader.save({ mirrorMode: 'telegram_only', onlyActiveWorkspaceMessages: false });
            await ctx.reply(`✉️ <b>${t('Mirror Mode')}: ${t('telegram_only')}</b>\n${t('Mirror answers only if the prompt was sent from Telegram.')}`, { parse_mode: 'HTML' });
            return;
        }

        const conf = loadConfig();
        const mirrorMode = conf.mirrorMode || (conf.onlyActiveWorkspaceMessages ? 'active' : 'all');
        const keyboard = new InlineKeyboard()
            .text(mirrorMode === 'all' ? `🟢 ${t('all')}` : `⚪ ${t('all')}`, 'set_mirror_mode:all').row()
            .text(mirrorMode === 'active' ? `🟢 ${t('active')}` : `⚪ ${t('active')}`, 'set_mirror_mode:active').row()
            .text(mirrorMode === 'telegram_only' ? `🟢 ${t('telegram_only')}` : `⚪ ${t('telegram_only')}`, 'set_mirror_mode:telegram_only');

        await replyHtml(ctx,
            `<b>⚙️ ${t('Mirror Settings')}</b>\n\n` +
            `${t('Current mirror mode:')} <b>${t(mirrorMode)}</b>\n\n` +
            `• <b>${t('all')}</b>: ${t('Mirror all open VS Code windows.')}\n` +
            `• <b>${t('active')}</b>: ${t('Mirror only the active (bound) workspace.')}\n` +
            `• <b>${t('telegram_only')}</b>: ${t('Mirror answers only if the prompt was sent from Telegram.')}`,
            keyboard
        );
    };

    bot.command('mirror', handleMirrorCommand);
    bot.command('mirror_all', handleMirrorCommand);

    // /cleanup command
    bot.command('cleanup', async (ctx) => {
        const days = Math.max(1, parseInt((ctx.match || '').trim(), 10) || 7);
        const guildId = String(ctx.chat!.id);
        const inactive = cleanupHandler.findInactiveSessions(guildId, days);
        const diskStats = cleanupHandler.getDiskStats();

        const diskInfo = `\n\n<b>💾 На диске (мусор):</b>\n` +
            `• Сиротские (вне IDE) чаты: <b>${formatBytes(diskStats.orphanedSizeBytes)}</b> (${diskStats.orphanedCount} шт)`;

        if (inactive.length === 0) {
            const kb = new InlineKeyboard();
            if (diskStats.orphanedCount > 0) {
                kb.text('🧹 Очистить сиротские файлы', CLEANUP_DISK_ORPHANED_BTN).row();
            }
            kb.text('❌ Закрыть', CLEANUP_CANCEL_BTN);

            await replyHtml(ctx, 
                `No inactive sessions older than <b>${days}</b> day(s).` + diskInfo,
                kb
            );
            return;
        }

        const list = inactive.slice(0, 20).map(({ binding, session }) => {
            const label = session?.displayName ?? binding.workspacePath;
            return `• ${escapeHtml(label)}`;
        }).join('\n');
        const extra = inactive.length > 20 ? `\n…and ${inactive.length - 20} more` : '';

        const keyboard = new InlineKeyboard()
            .text('📦 Archive Topics', `${CLEANUP_ARCHIVE_BTN}:${days}`)
            .text('🗑 Delete Topics', `${CLEANUP_DELETE_BTN}:${days}`).row()
            .text('🧹 Clean Orphaned Files', CLEANUP_DISK_ORPHANED_BTN)
            .text('🧹 Clean All Inactive Files', CLEANUP_DISK_ALL_INACTIVE_BTN).row()
            .text('❌ Cancel', CLEANUP_CANCEL_BTN);

        await replyHtml(ctx,
            `<b>🧹 Cleanup</b>\n\n` +
            `Found <b>${inactive.length}</b> session(s) older than <b>${days}</b> day(s):\n\n` +
            `${list}${extra}` + 
            diskInfo + `\n\n` +
            `Choose an action:`,
            keyboard,
        );
    });

    // /disk command to manage disk files directly
    bot.command(['disk', 'cleanup_disk'], async (ctx) => {
        const diskStats = cleanupHandler.getDiskStats();
        
        let text = `<b>💾 Статистика диска Antigravity</b>\n\n` +
            `• <b>Всего папок чатов:</b> ${formatBytes(diskStats.totalSizeBytes)} (${diskStats.totalCount} шт)\n` +
            `• <b>Из них сиротских (вне IDE):</b> <b>${formatBytes(diskStats.orphanedSizeBytes)}</b> (${diskStats.orphanedCount} шт)\n\n` +
            `<i>Сиротские чаты — это файлы диалогов, которые были удалены из левой панели IDE, но всё ещё физически занимают место на вашем диске в папке .gemini/antigravity-ide/.</i>`;
            
        const keyboard = new InlineKeyboard();
        if (diskStats.orphanedCount > 0) {
            keyboard.text('🧹 Очистить сиротские файлы', CLEANUP_DISK_ORPHANED_BTN).row();
            keyboard.text('🧹 Очистить все неактивные файлы', CLEANUP_DISK_ALL_INACTIVE_BTN).row();
        }
        keyboard.text('❌ Закрыть', CLEANUP_CANCEL_BTN);

        await replyHtml(ctx, text, keyboard);
    });

    // /screenshot command
    bot.command('screenshot', async (ctx) => {
        await handleScreenshot(
            async (input, caption) => { await ctx.replyWithPhoto(input, { caption }); },
            async (text) => { await ctx.reply(text); },
            getCurrentCdp(bridge),
        );
    });

    // /close command
    bot.command('close', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
        if (!cdp) {
            await ctx.reply('⚠️ No active Antigravity session to close.');
            return;
        }
        const projectName = (resolved.ok ? resolved.projectName : null) ?? cdp.getCurrentWorkspaceName();
        if (!projectName) {
            await ctx.reply('⚠️ No active workspace bound to this chat. Cannot close.');
            return;
        }
        try {
            await replyHtml(ctx, `🛑 Closing Antigravity workspace: <code>${escapeHtml(projectName)}</code>…`);
            await bridge.pool.closeBrowserWorkspace(projectName);
            await ctx.reply('✅ Workspace closed. Send a new prompt or use /workspace to reconnect.');
        } catch (e: any) {
            await ctx.reply(`❌ Error closing workspace: ${e.message}`);
        }
    });

    // /stop command
    bot.command('stop', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
        if (!cdp) { await ctx.reply('⚠️ Not connected to CDP.'); return; }

        try {
            const contextId = cdp.getPrimaryContextId();
            const callParams: Record<string, unknown> = { expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON, returnByValue: true, awaitPromise: false };
            if (contextId !== null) callParams.contextId = contextId;
            const result = await cdp.call('Runtime.evaluate', callParams);
            const value = result?.result?.value;

            userStopRequestedChannels.add(channelKey(ch));
            const keyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');

            if (value?.ok) {
                await replyHtml(ctx, `<b>⏹️ Generation Interrupted</b>\nAI response generation was safely stopped.`, keyboard);
            } else {
                await replyHtml(ctx, `<b>⏹️ Generation Interrupted / Already Stopped</b>\nCould not click Stop button in IDE (${escapeHtml(value?.error || 'not found')}), but you can still undo any pending changes.`, keyboard);
            }
        } catch (e: any) {
            await ctx.reply(`❌ Error during stop: ${e.message}`);
        }
    });

    // /allow, /allow_chat, /deny commands
    const handleApprovalCommand = async (
        ctx: Context,
        action: 'approve' | 'always_allow' | 'deny',
    ) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const projectName = (resolved.ok ? resolved.projectName : null) ?? bridge.lastActiveWorkspace;
        const detector = projectName ? bridge.pool.getApprovalDetector(projectName) : undefined;

        if (!detector) {
            await ctx.reply('⚠️ No approval detector found. Make sure a workspace is connected.');
            return;
        }

        let success = false;
        let actionLabel = '';
        if (action === 'approve') { success = await detector.approveButton(); actionLabel = 'Allow'; }
        else if (action === 'always_allow') { success = await detector.alwaysAllowButton(); actionLabel = 'Allow Chat'; }
        else { success = await detector.denyButton(); actionLabel = 'Deny'; }

        if (success) {
            await ctx.reply(`✅ ${actionLabel} sent to IDE — waiting for response.`);
        } else {
            await ctx.reply('⚠️ Approval button not found in IDE. The dialog may have already been resolved or is not visible.');
        }
    };

    bot.command('allow', (ctx) => handleApprovalCommand(ctx, 'approve'));
    bot.command('allow_chat', (ctx) => handleApprovalCommand(ctx, 'always_allow'));
    bot.command('deny', (ctx) => handleApprovalCommand(ctx, 'deny'));

    // /workspace and /project commands
    bot.command(['workspace', 'project'], async (ctx) => {
        const workspaces = workspaceService.getRecentWorkspaces();
        const { text, keyboard } = buildWorkspaceListUI(workspaces, 0);
        await replyHtml(ctx, text, keyboard);
    });

    // /new command
    bot.command('new', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        try {
            const chatResult = await chatSessionService.startNewChat(resolved.cdp);
            if (chatResult.ok) {
                const key = channelKey(ch);
                chatSessionRepo.resetSession(key);
                await replyHtml(ctx, `<b>💬 New Chat Started</b>\nSend your message now.`);
            } else {
                await ctx.reply(`⚠️ Could not start new chat: ${chatResult.error}`);
            }
        } catch (e: any) {
            await ctx.reply(`⚠️ Error: ${e.message}`);
        }
    });

    // /chat command
    bot.command('chat', async (ctx) => {
        const ch = getChannel(ctx);
        const key = channelKey(ch);
        const session = chatSessionRepo.findByChannelId(key);

        if (!session) {
            const activeNames = bridge.pool.getActiveWorkspaceNames();
            const anyCdp = activeNames.length > 0 ? bridge.pool.getConnected(activeNames[0]) : null;
            const info = anyCdp
                ? await chatSessionService.getCurrentSessionInfo(anyCdp)
                : { title: '(CDP Disconnected)', hasActiveChat: false };

            await replyHtml(ctx,
                `<b>💬 Chat Session Info</b>\n\n` +
                `<b>Title:</b> ${escapeHtml(info.title)}\n` +
                `<b>Status:</b> ${info.hasActiveChat ? '🟢 Active' : '⚪ Inactive'}\n\n` +
                `<i>Use /workspace to bind a workspace first.</i>`
            );
            return;
        }

        const allSessions = chatSessionRepo.findByCategoryId(session.categoryId);
        const sessionList = allSessions.map(s => {
            const name = s.displayName || `session-${s.sessionNumber}`;
            const current = s.channelId === key ? ' ← Current' : '';
            return `• ${name}${current}`;
        }).join('\n');

        await replyHtml(ctx,
            `<b>💬 Chat Session Info</b>\n\n` +
            `<b>Current:</b> #${session.sessionNumber} — ${escapeHtml(session.displayName || '(Unset)')}\n` +
            `<b>Project:</b> ${escapeHtml(session.workspacePath)}\n` +
            `<b>Total sessions:</b> ${allSessions.length}\n\n` +
            `<b>Sessions:</b>\n${escapeHtml(sessionList)}`
        );
    });

    // /chats command
    bot.command('chats', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

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
    });

    // /ping command
    bot.command('ping', async (ctx) => {
        const start = Date.now();
        const msg = await ctx.reply('🏓 Pong!');
        const latency = Date.now() - start;
        await bot.api.editMessageText(ctx.chat!.id, msg.message_id, `🏓 Pong! Latency: <b>${latency}ms</b>`, { parse_mode: 'HTML' });
    });

    // /history command
    bot.command('history', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        const countArg = (ctx.match || '').trim();
        let count = 5;
        if (countArg) {
            const parsed = parseInt(countArg, 10);
            if (!isNaN(parsed)) {
                count = Math.max(1, Math.min(20, parsed));
            }
        }

        const statusMsg = await ctx.reply('🔍 ' + t('Scanning sessions in Antigravity...'));
        try {
            const history = await chatSessionService.getChatHistory(resolved.cdp, count);
            
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

            if (history.length === 0) {
                await replyHtml(ctx, t('No messages found in history.'));
                return;
            }

            const formattedTurns = history.map(turn => {
                if (turn.role === 'user') {
                    return `👤 <b>${t('You')}:</b>\n${escapeHtml(turn.text || '')}`;
                } else {
                    return `🤖 <b>${t('Assistant')}:</b>\n${htmlToTelegramHtml(turn.html || '')}`;
                }
            });

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
    });

    // /undo command
    bot.command('undo', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        const statusMsg = await ctx.reply('↩️ ' + t('Rolling back changes in Antigravity...'));
        try {
            const rollbackResult = await chatSessionService.rollbackLastChanges(resolved.cdp);
            
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

            if (rollbackResult.ok) {
                await ctx.reply('✅ ' + t('Last changes successfully rolled back in IDE.'));
            } else {
                await ctx.reply(`❌ ${t('Failed to rollback')}: ${rollbackResult.error || t('Undo button not found')}`);
            }
        } catch (e: any) {
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
            await ctx.reply(`❌ ${t('Failed to rollback')}: ${e.message}`);
        }
    });

    return { handleStatus };
}
