import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import Database from 'better-sqlite3';
import * as https from 'https';
import path from 'path';
import WebSocket from 'ws';
// @ts-ignore
import fetch from 'node-fetch';
import * as fs from 'fs';

import { t, initI18n, Language } from '../utils/i18n';
import { logger } from '../utils/logger';
import type { LogLevel } from '../utils/logger';
import { loadConfig, resolveResponseDeliveryMode } from '../utils/config';
import { ConfigLoader } from '../utils/configLoader';
import { parseMessageContent } from '../commands/messageParser';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { CleanupCommandHandler, CLEANUP_ARCHIVE_BTN, CLEANUP_DELETE_BTN, CLEANUP_CANCEL_BTN, CLEANUP_DISK_ORPHANED_BTN, CLEANUP_DISK_ALL_INACTIVE_BTN } from '../commands/cleanupCommandHandler';

import { ModeService, AVAILABLE_MODES, MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceService, RecentWorkspace } from '../services/workspaceService';
import { TelegramTopicManager } from './telegramTopicManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';

import { CdpService } from '../services/cdpService';
import { ChatSessionService } from '../services/chatSessionService';
import { ResponseMonitor } from '../services/responseMonitor';
import { buildClickScript, RESPONSE_SELECTORS } from '../utils/domSelectors';
import { ensureAntigravityRunning } from '../services/antigravityLauncher';
import { getAntigravityCdpHint, isTitleMatch, getWorkspaceDisplayPath } from '../utils/pathUtils';
import { CDP_PORTS } from '../utils/cdpPorts';
import { AutoAcceptService, AutoAcceptSettings } from '../services/autoAcceptService';
import { PromptDispatcher } from '../services/promptDispatcher';
import {
    CdpBridge,
    ensureApprovalDetector,
    ensureErrorPopupDetector,
    ensurePlanningDetector,
    ensureUserMessageDetector,
    getCurrentCdp,
    initCdpBridge,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
    parseApprovalCustomId,
    parseErrorPopupCustomId,
    parsePlanningCustomId,
    buildApprovalCustomId,
} from '../services/cdpBridgeManager';
import { ChannelContext } from '../services/messengerPort';
import { TelegramAdapter } from './telegramAdapter';
import {
    resolveWorkspaceAndCdp as resolveWorkspaceAndCdpImpl,
    channelKeyFromChannel,
    ResolveOutcome,
} from '../services/workspaceResolver';
import { classifyAssistantSegments, extractAssistantSegmentsPayloadScript } from '../services/assistantDomExtractor';
import { buildModeModelLines, splitForEmbedDescription } from '../utils/streamMessageFormatter';
import { formatForTelegram, splitOutputAndLogs, escapeHtml, splitTelegramHtml } from '../utils/telegramFormatter';
import { htmlToTelegramHtml } from '../utils/htmlToTelegramMarkdown';
import {
    buildPromptWithAttachmentUrls,
    cleanupInboundImageAttachments,
    downloadTelegramImages,
    InboundImageAttachment,
    isImageAttachment,
    toTelegramInputFile,
} from '../utils/imageHandler';
import { checkWhisperAvailability, downloadTelegramVoice, transcribeVoice } from '../utils/voiceHandler';
import { buildModeUI, sendModeUI } from '../ui/modeUi';
import { buildModelsUI, sendModelsUI } from '../ui/modelsUi';
import { sendTemplateUI, TEMPLATE_BTN_PREFIX, parseTemplateButtonId } from '../ui/templateUi';
import {
    sendAutoAcceptUI,
    AUTOACCEPT_TOGGLE_MASTER,
    AUTOACCEPT_TOGGLE_CAT_PREFIX,
    AUTOACCEPT_ALL_ON,
    AUTOACCEPT_ALL_OFF,
    AUTOACCEPT_BTN_REFRESH,
} from '../ui/autoAcceptUi';
import { handleScreenshot } from '../ui/screenshotUi';
import { buildWorkspaceListUI, PROJECT_SELECT_ID, PROJECT_PAGE_PREFIX, parseProjectPageId, projectPathCache } from '../ui/projectListUi';
import { buildSessionPickerUI, SESSION_SELECT_ID, isSessionSelectId, sessionTitleCache } from '../ui/sessionPickerUi';
import {
    PLAN_VIEW_BTN, PLAN_PROCEED_BTN, PLAN_EDIT_BTN, PLAN_REFRESH_BTN, PLAN_PAGE_PREFIX,
    buildPlanNotificationUI, buildPlanContentUI, paginatePlanContent,
} from '../ui/planUi';
import {
    INTERRUPT_QUEUE_PREFIX, INTERRUPT_NOW_PREFIX, INTERRUPT_DISCARD_PREFIX,
    buildInterruptUI, safeCallbackKey,
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
import { normalizeForHash } from '../services/userMessageDetector';

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
import { registerCommands } from './commands';
import { registerCallbacks } from './callbacks';
import { registerMessageHandlers } from './messageHandlers';

const channelKey = channelKeyFromChannel;
const TELEGRAM_MSG_LIMIT = 4096;




// =============================================================================
// Bot main entry point
// =============================================================================

export const startBot = async (cliLogLevel?: LogLevel) => {
    const config = loadConfig();
    logger.setLogLevel(cliLogLevel ?? config.logLevel);

    const lang = (process.env.LANGUAGE as Language) || 'ru';
    initI18n(lang);

    const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : ConfigLoader.getDefaultDbPath();
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const modeService = new ModeService();
    const modelService = new ModelService();
    const templateRepo = new TemplateRepository(db);
    const workspaceBindingRepo = new WorkspaceBindingRepository(db);
    const chatSessionRepo = new ChatSessionRepository(db);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);

    await ensureAntigravityRunning();

    const bridge = initCdpBridge();
    (bridge as any).db = db;
    logger.info(`[startup] Loaded Auto-Accept status: enabled=${bridge.autoAccept.isEnabled()}, settings=${JSON.stringify(bridge.autoAccept.getSettings())}`);
    bridge.botToken = config.telegramBotToken;

    const chatSessionService = new ChatSessionService();
    const titleGenerator = new TitleGeneratorService();
    const promptDispatcher = new PromptDispatcher({
        bridge,
        modeService,
        modelService,
        sendPromptImpl: sendPromptToAntigravity,
        onTaskComplete: (channel, wsKey) => {
            // Auto-queue fallback: when a task finishes, auto-dispatch any
            // pending interrupts the user hasn't acted on yet.
            // Interrupt state uses safeCallbackKey-truncated keys, so match that here.
            const interruptKey = safeCallbackKey(wsKey);
            if (!hasPendingInterrupts(interruptKey)) return;

            const queued = drainPendingInterrupts(interruptKey);
            logger.info(`[autoQueue] Task done for ${wsKey} — auto-dispatching ${queued.length} queued message(s)`);

            // Extract project name from wsKey (format: "ws:{projectName}" or channel key)
            const projectName = wsKey.startsWith('ws:') ? wsKey.slice(3) : null;

            for (const pending of queued) {
                // Re-resolve CDP from pool to avoid stale references
                const freshCdp = projectName ? bridge.pool.getConnected(projectName) : null;
                if (!freshCdp) {
                    logger.warn(`[autoQueue] Workspace ${wsKey} no longer connected, discarding queued message`);
                    if (pending.inboundImages?.length) {
                        cleanupInboundImageAttachments(pending.inboundImages).catch(() => {});
                    }
                    continue;
                }

                // Edit the interrupt keyboard message to show it was auto-queued
                if (pending.interruptMsgId) {
                    bot.api.editMessageText(
                        pending.channel.chatId,
                        pending.interruptMsgId,
                        '📥 Task finished — sending your queued message…',
                        { parse_mode: 'HTML' },
                    ).catch((e: any) => { logger.debug('[autoQueue] editMessage failed:', e); });
                }
                promptDispatcher.send({
                    channel: pending.channel,
                    prompt: pending.prompt,
                    cdp: freshCdp,
                    inboundImages: pending.inboundImages,
                    options: pending.options,
                }).catch((e: any) => { logger.error('[autoQueue] dispatch failed:', e); });
            }
        },
    });

    const slashCommandHandler = new SlashCommandHandler(templateRepo);
    const cleanupHandler = new CleanupCommandHandler(chatSessionRepo, workspaceBindingRepo);

    let botConfig: any = {};
    const fallbackIpsRaw = process.env.TELEGRAM_FALLBACK_IPS || '';
    const fallbackIps = fallbackIpsRaw.split(',').map(ip => ip.trim()).filter(Boolean);
    if (fallbackIps.length > 0) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const agent = new https.Agent({
            keepAlive: true,
            rejectUnauthorized: false,
            servername: 'api.telegram.org',
        });
        const customFetch = (url: any, init: any) => {
            const headers = {
                ...(init?.headers || {}),
                'Host': 'api.telegram.org',
            };
            return fetch(url, {
                ...init,
                agent,
                headers,
            });
        };
        botConfig = {
            client: {
                apiRoot: `https://${fallbackIps[0]}`,
                fetch: customFetch as any,
            },
        };
        logger.warn(`[Bot] Using Telegram fallback IP: ${fallbackIps[0]} with Host header and SNI mapping via custom fetch.`);
    }
    const bot = new Bot(config.telegramBotToken, botConfig);
    const topicManager = new TelegramTopicManager(bot.api, 0);
    bridge.messenger = new TelegramAdapter(bot.api, topicManager);

    // Notify user on WebSocket connection lifecycle events
    bridge.pool.on('workspace:disconnected', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel) return;
        bot.api.sendMessage(channel.chatId, `⚠️ <b>${escapeHtml(projectName)}</b>: Connection lost. Reconnecting…`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err: any) => logger.error('[Bot] Failed to send disconnect notification:', err));
    });

    bridge.pool.on('workspace:reconnected', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel) return;
        bot.api.sendMessage(channel.chatId, `✅ <b>${escapeHtml(projectName)}</b>: Reconnected.`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err: any) => logger.error('[Bot] Failed to send reconnect notification:', err));
    });

    bridge.pool.on('workspace:reconnectFailed', async (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel) return;

        // Find workspace path from bindings
        const binding = workspaceBindingRepo.findByChannelId(channelKey(channel));
        const activeProjectName = binding ? bridge.pool.extractProjectName(binding.workspacePath) : null;
        const isMain = activeProjectName === projectName;

        // Try to get workspace path
        let workspacePath = '';
        if (binding && isMain) {
            workspacePath = binding.workspacePath;
        } else {
            // Find in recent workspaces or bindings by name
            const allBindings = workspaceBindingRepo.findAll();
            const found = allBindings.find(b => bridge.pool.extractProjectName(b.workspacePath) === projectName);
            if (found) {
                workspacePath = found.workspacePath;
            } else {
                const recent = workspaceService.getRecentWorkspaces();
                const matched = recent.find(w => bridge.pool.extractProjectName(w.path) === projectName);
                if (matched) workspacePath = matched.path;
            }
        }

        const keyboard = new InlineKeyboard();
        
        if (workspacePath) {
            const shortId = `rest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            restoreWindowPathCache.set(shortId, workspacePath);
            keyboard.text(`🔄 ${t('Restore')} ${projectName}`, `restore_window:${shortId}`).row();
        }

        let text = `❌ <b>${escapeHtml(projectName)}</b>: ${t('Connection closed.')}\n\n`;

        if (isMain) {
            text += `${t('The active workspace is offline. You can restore it or switch to another open window:')}\n`;
            
            // Scan other active windows
            const activeWindows = await scanActiveWindows();
            const otherWindows = activeWindows.filter(w => w.projectName !== projectName);
            
            if (otherWindows.length > 0) {
                text += `\n<b>${t('Other open windows:')}</b>\n`;
                let btnCount = 0;
                for (const win of otherWindows) {
                    if (win.workspacePath) {
                        const cleanName = win.projectName.replace(/\.code-workspace$/i, '');
                        const swId = `sw_rec_${btnCount++}_${Date.now()}`;
                        statusWindowPathCache.set(swId, win.workspacePath);
                        keyboard.text(`🔌 ${cleanName}`, `switch_window:${swId}`).row();
                    }
                }
            } else {
                text += `\n<i>${t('No other open IDE windows detected.')}</i>`;
            }
        } else {
            text += `${t('Would you like to restore this workspace window?')}`;
        }

        bot.api.sendMessage(channel.chatId, text, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: keyboard,
        }).catch((err: any) => logger.error('[Bot] Failed to send reconnect-failed notification:', err));
    });

    // Auth middleware
    bot.use(async (ctx, next) => {
        const userId = String(ctx.from?.id ?? '');
        if (!config.allowedUserIds.includes(userId)) {
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery({ text: 'You do not have permission.' });
            }
            return;
        }
        await next();
    });

    // Helper to build ChannelContext from context
    const getChannel = (ctx: Context): ChannelContext => ({
        chatId: ctx.chat!.id,
        threadId: ctx.message?.message_thread_id ?? undefined,
    });

    const getChannelFromCb = (ctx: Context): ChannelContext => ({
        chatId: ctx.chat!.id,
        threadId: ctx.callbackQuery?.message?.message_thread_id ?? undefined,
    });

    const setupWorkspaceDetectors = (cdp: any, projectName: string, channel: ChannelContext) => {
        bridge.lastActiveWorkspace = projectName;
        bridge.lastActiveChannel = channel;
        registerApprovalWorkspaceChannel(bridge, projectName, channel);
        ensureApprovalDetector(bridge, cdp, projectName);
        ensureErrorPopupDetector(bridge, cdp, projectName);
        ensurePlanningDetector(bridge, cdp, projectName);

        const onUserMessageCallback = (info: any): boolean => {
            const conf = loadConfig();
            const normalized = normalizeForHash(info.text);
            const wasFromTelegram = telegramSentPrompts.has(normalized);

            if (wasFromTelegram) {
                telegramSentPrompts.delete(normalized);
            }

            // Check mirror mode
            const mirrorMode = conf.mirrorMode || (conf.onlyActiveWorkspaceMessages ? 'active' : 'all');

            if (mirrorMode === 'telegram_only') {
                if (!wasFromTelegram) {
                    logger.debug(`[UserMessageDetector:${projectName}] mirrorMode is telegram_only and this message did not originate from Telegram, skipping.`);
                    return true;
                }
            } else if (mirrorMode === 'active') {
                const binding = workspaceBindingRepo.findByChannelId(channelKey(channel));
                const activeProjectName = binding ? bridge.pool.extractProjectName(binding.workspacePath) : null;
                if (activeProjectName !== projectName) {
                    logger.debug(`[UserMessageDetector:${projectName}] mirrorMode is active and this is not the active workspace (${activeProjectName}), skipping user message mirror.`);
                    return true;
                }
            }

            logger.info(`[UserMessageDetector:${projectName}] Detected user message from IDE: "${info.text.slice(0, 50)}..."`);
            
            if (promptDispatcher.isBusy(channel, cdp)) {
                logger.debug(`[UserMessageDetector:${projectName}] Workspace is busy, skipping user message mirror.`);
                return true;
            }

            if (!wasFromTelegram) {
                // 1. Send the user message to the Telegram channel
                const cleanProjName = projectName.replace(/\.code-workspace$/i, '');
                const userMsgText = `👤 [IDE: ${cleanProjName}]: ${info.text}`;
                bot.api.sendMessage(channel.chatId, userMsgText, {
                    message_thread_id: channel.threadId,
                }).catch(e => logger.error('[UserMessageDetector] Failed to send user message to TG:', e));
            }

            // 2. Start mirroring the response using acquireLock to block TG commands
            const mirrorPromise = mirrorResponseToTelegram(bridge, channel, cdp, info.text, {
                chatSessionService,
                chatSessionRepo,
                topicManager,
                titleGenerator,
                modelService,
                modeService,
                                workspaceBindingRepo
            });

            promptDispatcher.acquireLock(channel, cdp, mirrorPromise);
            return true;
        };
        ensureUserMessageDetector(bridge, cdp, projectName, onUserMessageCallback);
    };

    const resolveWorkspaceAndCdp = (ch: ChannelContext): Promise<ResolveOutcome> =>
        resolveWorkspaceAndCdpImpl(ch, {
            findBinding: (key) => workspaceBindingRepo.findByChannelId(key),
            getWorkspacePath: (name) => workspaceService.getWorkspacePath(name),
            getOrConnect: (fullPath) => bridge.pool.getOrConnect(fullPath, false, undefined, false),
            extractProjectName: (fullPath) => bridge.pool.extractProjectName(fullPath),
            onConnected: (cdp, projectName, channel) => {
                setupWorkspaceDetectors(cdp, projectName, channel);
            },
        });

    const replyHtml = async (ctx: Context, text: string, keyboard?: InlineKeyboard) => {
        await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
        });
    };

    

    // Helper to query workspace path directly from a running IDE window via CDP
    const queryWorkspacePath = async (wsUrl: string): Promise<{ workspacePath: string | null; workspaceId: string | null; sessionInfo?: { title: string; hasActiveChat: boolean } | null } | null> => {
        return new Promise((resolve) => {
            const ws = new WebSocket(wsUrl);
            let resolved = false;
            const contexts: number[] = [];
            
            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
                try { ws.close(); } catch {}
            };

            const timeout = setTimeout(cleanup, 4000);

            ws.on('message', (dataStr) => {
                try {
                    const data = JSON.parse(dataStr.toString());
                    if (data.method === 'Runtime.executionContextCreated') {
                        const cid = data.params?.context?.id;
                        if (cid && !contexts.includes(cid)) {
                            contexts.push(cid);
                        }
                    }
                } catch {}
            });

            ws.on('open', () => {
                if (resolved) return;
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.enable',
                    params: {}
                }));

                setTimeout(async () => {
                    if (resolved) return;
                    
                    let workspacePath: string | null = null;
                    let workspaceId: string | null = null;
                    let sessionInfo: { title: string; hasActiveChat: boolean } | null = null;

                    const contextsToTry = [undefined, ...contexts];
                    
                    for (const cid of contextsToTry) {
                        try {
                            const res = await new Promise<any>((resEval, rejEval) => {
                                const evalId = Math.floor(Math.random() * 1000000);
                                const onEvalMsg = (msg: any) => {
                                    try {
                                        const d = JSON.parse(msg.toString());
                                        if (d.id === evalId) {
                                            ws.removeListener('message', onEvalMsg);
                                            if (d.error) rejEval(d.error);
                                            else resEval(d.result?.result?.value);
                                        }
                                    } catch {}
                                };
                                ws.on('message', onEvalMsg);
                                ws.send(JSON.stringify({
                                    id: evalId,
                                    method: 'Runtime.evaluate',
                                    params: {
                                        expression: `(async () => {
                                            let workspacePath = null;
                                            let workspaceId = null;
                                            const vs = typeof vscode !== 'undefined' ? vscode : (typeof window !== 'undefined' && window.vscode ? window.vscode : null);
                                            if (vs && vs.context) {
                                                try {
                                                    const config = typeof vs.context.configuration === 'function' 
                                                        ? vs.context.configuration()
                                                        : (typeof vs.context.resolveConfiguration === 'function'
                                                            ? await vs.context.resolveConfiguration()
                                                            : null);
                                                    if (config && config.workspace) {
                                                        workspaceId = config.workspace.id || null;
                                                        
                                                        const cp = config.workspace.configPath;
                                                        const uri = config.workspace.uri;
                                                        const rawPath = cp?.fsPath || cp?._fsPath || cp?.path || uri?.fsPath || uri?._fsPath || uri?.path || null;
                                                        if (rawPath) {
                                                            let clean = rawPath.trim();
                                                            if (clean.startsWith('file:')) {
                                                                clean = clean.replace(/^file:\\/\\/\\/?/, '');
                                                            }
                                                            clean = decodeURIComponent(clean);
                                                            clean = clean.replace(/^\\/([a-zA-Z]):/, '$1:');
                                                            clean = clean.replace(/\\//g, '\\\\');
                                                            workspacePath = clean;
                                                        }
                                                    }
                                                } catch (e) {
                                                    // ignore
                                                }
                                            }
                                            
                                            let title = '';
                                            let hasActiveChat = false;
                                            const panel = document.querySelector('.antigravity-agent-side-panel');
                                            if (panel) {
                                                const header = panel.querySelector('div[class*="border-b"]');
                                                if (header) {
                                                    const titleEl = header.querySelector('div[class*="text-ellipsis"]');
                                                    title = titleEl ? (titleEl.textContent || '').trim() : '';
                                                    hasActiveChat = title.length > 0 && title !== 'Agent';
                                                    if (!title) {
                                                        title = '(Untitled)';
                                                    }
                                                }
                                            }
                                            
                                            return {
                                                workspacePath,
                                                workspaceId,
                                                sessionInfo: title ? { title, hasActiveChat } : null
                                            };
                                        })()`,
                                        returnByValue: true,
                                        awaitPromise: true,
                                        contextId: cid
                                    }
                                }));
                                setTimeout(() => {
                                    ws.removeListener('message', onEvalMsg);
                                    rejEval(new Error('timeout'));
                                }, 1000);
                            });

                            if (res) {
                                if (res.workspacePath && !workspacePath) {
                                    workspacePath = res.workspacePath;
                                }
                                if (res.workspaceId && !workspaceId) {
                                    workspaceId = res.workspaceId;
                                }
                                if (res.sessionInfo && !sessionInfo) {
                                    sessionInfo = res.sessionInfo;
                                }
                            }
                        } catch (e) {
                            // ignore
                        }
                    }

                    clearTimeout(timeout);
                    resolved = true;
                    resolve({ workspacePath, workspaceId, sessionInfo });
                    try { ws.close(); } catch {}
                }, 400);
            });

            ws.on('error', cleanup);
        });
    };

    // Scan active IDE windows
    const scanActiveWindows = async () => {
        const recentWorkspaces = workspaceService.getRecentWorkspaces();
        const activeWindows: {
            port: number;
            title: string;
            workspacePath: string | null;
            projectName: string;
            webSocketDebuggerUrl: string;
            sessionInfo?: { title: string; hasActiveChat: boolean } | null;
        }[] = [];

        await Promise.all(CDP_PORTS.map(async (port) => {
            try {
                // Fetch devtools targets list from port (timeout after 1.5s to avoid blocking)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 1500);
                const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (res.ok) {
                    const list = await res.json() as any[];
                    const workbenchPages = list.filter(
                        (t: any) =>
                            t.type === 'page' &&
                            t.webSocketDebuggerUrl &&
                            !t.title?.includes('Launchpad') &&
                            !t.url?.includes('workbench-jetski-agent') &&
                            t.url?.includes('workbench')
                    );

                    // Query each workbench page's path using WebSocket in parallel
                    await Promise.all(workbenchPages.map(async (page) => {
                        const title = page.title || '';
                        let workspacePath: string | null = null;
                        let matchedWorkspace: RecentWorkspace | null = null;
                        let sessionInfo: { title: string; hasActiveChat: boolean } | null = null;

                        // Reuse already connected cdp service path to avoid CDP evaluation lag/hangs
                        const existingPath = bridge.pool.getWorkspacePathByWebSocketUrl(page.webSocketDebuggerUrl);
                        let cdpInfo = null;
                        if (existingPath) {
                            let cachedSession: { title: string; hasActiveChat: boolean } | null = null;
                            const cdp = bridge.pool.getConnectedByWebSocketUrl(page.webSocketDebuggerUrl);
                            if (cdp) {
                                try {
                                    cachedSession = await chatSessionService.getCurrentSessionInfo(cdp);
                                } catch (e) {
                                    // ignore
                                }
                            }
                            cdpInfo = { workspacePath: existingPath, workspaceId: null, sessionInfo: cachedSession };
                            sessionInfo = cachedSession;
                        } else {
                            cdpInfo = await queryWorkspacePath(page.webSocketDebuggerUrl);
                            sessionInfo = cdpInfo?.sessionInfo || null;
                        }
                        let tempProjectName = '';
                        if (cdpInfo && cdpInfo.workspacePath) {
                            if (cdpInfo.workspacePath.endsWith('workspace.json')) {
                                workspacePath = cdpInfo.workspacePath;
                                try {
                                    if (fs.existsSync(cdpInfo.workspacePath)) {
                                        const content = fs.readFileSync(cdpInfo.workspacePath, 'utf8');
                                        const parsed = JSON.parse(content);
                                        if (parsed.folders && Array.isArray(parsed.folders) && parsed.folders.length > 0) {
                                            const folderNames = parsed.folders.map((f: any) => {
                                                const p = f.path || f.uri || '';
                                                let clean = p.trim();
                                                if (clean.startsWith('file:')) {
                                                    clean = clean.replace(/^file:\/\/\/?/, '');
                                                }
                                                clean = decodeURIComponent(clean);
                                                clean = clean.replace(/^\/([a-zA-Z]):/, '$1:');
                                                return path.basename(clean.replace(/\//g, '\\'));
                                            }).filter(Boolean);

                                            if (folderNames.length > 1) {
                                                tempProjectName = `🗂️ ${folderNames.join(' + ')}`;
                                            } else if (folderNames.length === 1) {
                                                tempProjectName = folderNames[0];
                                            }
                                        }
                                    }
                                } catch (err) {
                                    logger.error(`[scanActiveWindows] Failed to parse workspace.json at ${cdpInfo.workspacePath}:`, err);
                                }
                            } else {
                                workspacePath = cdpInfo.workspacePath;
                                const normPath = workspacePath!.toLowerCase().replace(/\//g, '\\').trim();
                                matchedWorkspace = recentWorkspaces.find(w => {
                                    const normWPath = w.path.toLowerCase().replace(/\//g, '\\').trim();
                                    return normWPath === normPath;
                                }) || null;
                            }
                        }

                        let projectName = '';
                        if (matchedWorkspace) {
                            projectName = matchedWorkspace.name;
                        } else if (workspacePath && !workspacePath.startsWith('empty-workspace:')) {
                            if (workspacePath.endsWith('workspace.json') && tempProjectName) {
                                projectName = tempProjectName;
                            } else {
                                projectName = path.basename(workspacePath);
                            }
                        } else {
                            // Fallback to title matching
                            for (const w of recentWorkspaces) {
                                const cleanName = w.name.replace(/\.code-workspace$/i, '');
                                if (isTitleMatch(title, cleanName)) {
                                    matchedWorkspace = w;
                                    break;
                                }
                            }

                            // Parse project name from title as fallback
                            const titleParts = title.split(/\s[—–-]\s/);
                            const parsedProjectName = titleParts.length >= 2 ? titleParts[titleParts.length - 2] : (titleParts[0] || 'Unknown');
                            const cleanParsedName = parsedProjectName.replace(/\s*\([^)]+\)$/, '').replace(/\.code-workspace$/i, '').trim();

                            // Fallback matching by project name equality
                            if (!matchedWorkspace && cleanParsedName !== 'Unknown') {
                                const normParsed = cleanParsedName.toLowerCase();
                                matchedWorkspace = recentWorkspaces.find(w => {
                                    const cleanWName = w.name.replace(/\.code-workspace$/i, '').toLowerCase().trim();
                                    return cleanWName === normParsed;
                                }) || null;
                            }

                            projectName = matchedWorkspace ? matchedWorkspace.name : cleanParsedName;
                            const isEmp = workspacePath && workspacePath.startsWith('empty-workspace:');
                            workspacePath = matchedWorkspace ? matchedWorkspace.path : (isEmp ? workspacePath : null);
                        }

                        if (!workspacePath) {
                            workspacePath = `empty-workspace:${port}:${page.id}`;
                            const name = (projectName && projectName !== 'Unknown') ? projectName : 'Antigravity';
                            projectName = `${name} (без папки)`;
                        } else if (workspacePath.startsWith('empty-workspace:')) {
                            const name = (projectName && projectName !== 'Unknown') ? projectName : 'Antigravity';
                            if (!name.endsWith(' (без папки)')) {
                                projectName = `${name} (без папки)`;
                            }
                        }

                        activeWindows.push({
                            port,
                            title,
                            workspacePath,
                            projectName: projectName.replace(/\.code-workspace$/i, ''),
                            webSocketDebuggerUrl: page.webSocketDebuggerUrl,
                            sessionInfo
                        });
                    }));
                }
            } catch (e) {
                // ignore unreachable port
            }
        }));

        return activeWindows;
    };

    const switchWorkspaceInternal = async (
        ctx: Context,
        workspacePath: string,
        silent: boolean = false
    ): Promise<{ key: string; fullPath: string; cleanFolderName: string; cdp: any } | null> => {
        const ch = getChannelFromCb(ctx);
        let key = channelKey(ch);
        const guildId = String(ch.chatId);
        const isForum = ctx.chat?.type === 'supergroup' && (ctx.chat as any).is_forum === true;
        const folderName = path.basename(workspacePath);
        const cleanFolderName = folderName.replace(/\.code-workspace$/i, '');
        const fullPath = workspaceService.getWorkspacePath(workspacePath);

        let cdp: any = null;

        const sessionKeyboard = new InlineKeyboard()
            .text(`💬 ${t('Dialogs')}`, 'current_dialogs')
            .text(`📜 ${t('History')}`, 'current_history');

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

                key = `${ch.chatId}:${topicId}`;

                workspaceBindingRepo.upsert({ channelId: key, workspacePath, guildId });
                cdp = await bridge.pool.getOrConnect(fullPath).catch((err: any) => {
                    logger.warn(`[WorkspaceSelectTopic] Proactive connection failed for ${workspacePath}:`, err?.message || err);
                    return null;
                });

                if (cdp) {
                    const projectName = bridge.pool.extractProjectName(workspacePath);
                    const targetChannel: ChannelContext = {
                        chatId: ch.chatId,
                        threadId: topicId,
                    };
                    setupWorkspaceDetectors(cdp, projectName, targetChannel);
                }

                if (!silent) {
                    let sessionStr = '';
                    if (cdp) {
                        try {
                            const sessionInfo = await chatSessionService.getCurrentSessionInfo(cdp);
                            if (sessionInfo.hasActiveChat) {
                                sessionStr = `\n💬 <b>Активный диалог:</b> ${escapeHtml(sessionInfo.title)}`;
                            } else {
                                sessionStr = `\n🆕 <b>Активный диалог:</b> Начинаем диалог с нуля`;
                            }
                        } catch (e) {
                            sessionStr = `\n💬 <b>Активный диалог:</b> Неизвестно`;
                        }
                    } else {
                        sessionStr = `\n💬 <b>Активный диалог:</b> Неизвестно`;
                    }

                    const text = `<b>💼 Рабочая область выбрана</b>\n\n` +
                        `✅ <b>${escapeHtml(cleanFolderName)}</b>\n` +
                        `<code>${escapeHtml(fullPath)}</code>\n` +
                        `${sessionStr}\n\n` +
                        `Отправляйте сообщения сюда для работы с этим проектом.\n` +
                        `Используйте /chats или /history для управления сессиями.`;

                    await bot.api.sendMessage(
                        ch.chatId,
                        text,
                        { parse_mode: 'HTML', message_thread_id: topicId, reply_markup: sessionKeyboard },
                    );
                }
                return { key, fullPath, cleanFolderName, cdp };
            } catch (e: any) {
                logger.warn(`[WorkspaceSelect] Topic creation failed, falling back: ${e.message}`);
            }
        }

        workspaceBindingRepo.upsert({ channelId: key, workspacePath, guildId });
        cdp = await bridge.pool.getOrConnect(fullPath).catch((err: any) => {
            logger.warn(`[WorkspaceSelect] Proactive connection failed for ${workspacePath}:`, err?.message || err);
            return null;
        });

        if (cdp) {
            const projectName = bridge.pool.extractProjectName(workspacePath);
            setupWorkspaceDetectors(cdp, projectName, ch);
        }

        if (!silent) {
            let sessionStr = '';
            if (cdp) {
                try {
                    const sessionInfo = await chatSessionService.getCurrentSessionInfo(cdp);
                    if (sessionInfo.hasActiveChat) {
                        sessionStr = `\n💬 <b>Активный диалог:</b> ${escapeHtml(sessionInfo.title)}`;
                    } else {
                        sessionStr = `\n🆕 <b>Активный диалог:</b> Начинаем диалог с нуля`;
                    }
                } catch (e) {
                    sessionStr = `\n💬 <b>Активный диалог:</b> Неизвестно`;
                }
            } else {
                sessionStr = `\n💬 <b>Активный диалог:</b> Неизвестно`;
            }

            const text = `<b>💼 Рабочая область выбрана</b>\n\n` +
                `✅ <b>${escapeHtml(cleanFolderName)}</b>\n` +
                `<code>${escapeHtml(fullPath)}</code>\n` +
                `${sessionStr}\n\n` +
                `Отправляйте сообщения сюда для работы с этим проектом.\n` +
                `Используйте /chats или /history для управления сессиями.`;

            try {
                await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: sessionKeyboard });
            } catch {
                await replyHtml(ctx, text, sessionKeyboard);
            }
        }

        return { key, fullPath, cleanFolderName, cdp };
    };

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
            const matchingWin = activeWindows.find(win => win.workspacePath && win.workspacePath.toLowerCase() === binding.workspacePath.toLowerCase());
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
        activeWindows.forEach((win) => {
            if (win.workspacePath && !bridge.pool.getConnected(win.projectName)) {
                bridge.pool.getOrConnect(win.workspacePath).then((cdp) => {
                    setupWorkspaceDetectors(cdp, win.projectName, ch);
                    logger.info(`[status] Proactively connected to open window: ${win.projectName}`);
                }).catch((err) => {
                    logger.debug(`[status] Failed proactive connection to open window ${win.projectName}:`, err?.message || err);
                });
            }
        });

        // Fetch session info ONLY for already connected windows to avoid CDP connection lag/hangs
        const activeWindowsWithSessions = await Promise.all(
            activeWindows.map(async (win) => {
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

    // Helper to format bytes
    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    };

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
    // Note: any active ResponseMonitor polling the closed workspace will encounter
    // errors until it times out, since the monitor is not pool-managed.
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
                // Even if stop button is not found (e.g. already in approval state or already stopped),
                // allow user to undo any pending changes.
                await replyHtml(ctx, `<b>⏹️ Generation Interrupted / Already Stopped</b>\nCould not click Stop button in IDE (${escapeHtml(value?.error || 'not found')}), but you can still undo any pending changes.`, keyboard);
            }
        } catch (e: any) {
            await ctx.reply(`❌ Error during stop: ${e.message}`);
        }
    });

    // /allow, /allow_chat, /deny commands — manual retry for stuck approval dialogs
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

            // Delete scanning status message
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
            
            // Delete status message
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
            
            // Delete status message
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


    // =============================================================================
    // Callback query handler (inline keyboard buttons)
    // =============================================================================

    const commands = registerCommands(bot, {
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
        setupWorkspaceDetectors,
        queryWorkspacePath,
        scanActiveWindows,
        switchWorkspaceInternal,
    });

    registerCallbacks(bot, {
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
    });

    registerMessageHandlers(bot, {
        config,
        bridge,
        modeService,
        modelService,
        chatSessionRepo,
        workspaceBindingRepo,
        chatSessionService,
        titleGenerator,
        promptDispatcher,
        slashCommandHandler,
        topicManager,
        resolveWorkspaceAndCdp,
        commands,
    });

    // Proactively connect to all existing workspace bindings on startup
    try {
        const bindings = workspaceBindingRepo.findAll();
        logger.info(`[startup] Found ${bindings.length} workspace binding(s). Connecting proactively...`);
        for (const binding of bindings) {
            const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            const channel: ChannelContext = {
                chatId: binding.channelId.includes(':') ? Number(binding.channelId.split(':')[0]) : Number(binding.channelId),
                threadId: binding.channelId.includes(':') ? Number(binding.channelId.split(':')[1]) : undefined,
            };
            
            const connectProactively = () => {
                bridge.pool.getOrConnect(workspacePath, false, undefined, false).then((cdp) => {
                    const projectName = bridge.pool.extractProjectName(binding.workspacePath);
                    logger.info(`[startup] Proactively connected to workspace: ${projectName} (${binding.workspacePath})`);
                    
                    setupWorkspaceDetectors(cdp, projectName, channel);

                    // Detect if a run is already in progress and start passive monitoring
                    cdp.call('Runtime.evaluate', {
                        expression: RESPONSE_SELECTORS.STOP_BUTTON,
                        returnByValue: true,
                    }).then((res: any) => {
                        const isGenerating = res?.result?.value?.isGenerating;
                        if (isGenerating) {
                            const conf = loadConfig();
                            if (conf.onlyActiveWorkspaceMessages) {
                                const binding = workspaceBindingRepo.findByChannelId(channelKey(channel));
                                const activeProjectName = binding ? bridge.pool.extractProjectName(binding.workspacePath) : null;
                                if (activeProjectName !== projectName) {
                                    logger.debug(`[startup] onlyActiveWorkspaceMessages is true and this is not the active workspace (${activeProjectName}), skipping passive monitoring.`);
                                    return;
                                }
                            }

                            logger.info(`[startup] Detected active run in progress for workspace ${binding.workspacePath}. Starting passive monitoring.`);
                            const lastUserMsg = 'Activity in IDE'; 
                            const mirrorPromise = mirrorResponseToTelegram(bridge, channel, cdp, lastUserMsg, {
                                chatSessionService,
                                chatSessionRepo,
                                topicManager,
                                titleGenerator,
                                modelService,
                                modeService,
                                workspaceBindingRepo
                            });
                            promptDispatcher.acquireLock(channel, cdp, mirrorPromise);
                        }
                    }).catch(err => {
                        logger.debug(`[startup] Stop button probe failed for ${binding.workspacePath}:`, err);
                    });

                }).catch((err) => {
                    logger.warn(`[startup] Failed proactive connection for ${binding.workspacePath}: ${err?.message || err}. Retrying in 10s...`);
                    setTimeout(connectProactively, 10000);
                });
            };
            connectProactively();
        }
    } catch (e: any) {
        logger.error('[startup] Proactive workspace connections failed:', e?.message || e);
    }

    const scanAndConnectNewWindows = async () => {
        try {
            const activeWindows = await scanActiveWindows();
            for (const win of activeWindows) {
                if (!win.workspacePath) continue;
                
                // Check if already connected
                if (bridge.pool.getConnected(win.projectName)) continue;

                // Find channel target: either from DB, or fallback to last active channel
                let targetChannel: ChannelContext | null = null;
                const bindings = workspaceBindingRepo.findAll();
                const matched = bindings.find(b => {
                    const normB = b.workspacePath.toLowerCase().replace(/\//g, '\\').trim();
                    const normW = win.workspacePath!.toLowerCase().replace(/\//g, '\\').trim();
                    return normB === normW;
                });

                if (matched) {
                    targetChannel = {
                        chatId: matched.channelId.includes(':') ? Number(matched.channelId.split(':')[0]) : Number(matched.channelId),
                        threadId: matched.channelId.includes(':') ? Number(matched.channelId.split(':')[1]) : undefined,
                    };
                } else if (bridge.lastActiveChannel) {
                    targetChannel = bridge.lastActiveChannel;
                }

                if (targetChannel) {
                    logger.info(`[background] Auto-connecting to newly discovered window: ${win.projectName} (${win.workspacePath})`);
                    bridge.pool.getOrConnect(win.workspacePath, false, undefined, false).then((cdp) => {
                        setupWorkspaceDetectors(cdp, win.projectName, targetChannel!);
                        logger.info(`[background] Successfully connected to window: ${win.projectName}`);
                    }).catch((err) => {
                        logger.debug(`[background] Failed auto-connection to ${win.projectName}:`, err?.message || err);
                    });
                }
            }

            // Prompt user if multiple windows are open but none are connected to the current channel/chat
            if (activeWindows.length > 1) {
                const bindings = workspaceBindingRepo.findAll();
                for (const binding of bindings) {
                    const ch: ChannelContext = {
                        chatId: binding.channelId.includes(':') ? Number(binding.channelId.split(':')[0]) : Number(binding.channelId),
                        threadId: binding.channelId.includes(':') ? Number(binding.channelId.split(':')[1]) : undefined,
                    };
                    const key = channelKey(ch);
                    
                    const bindingProjectName = bridge.pool.extractProjectName(binding.workspacePath);
                    const isBindingConnected = !!bridge.pool.getConnected(bindingProjectName);
                    
                    if (!isBindingConnected && !promptSelectionSentChannels.has(key)) {
                        promptSelectionSentChannels.add(key);
                        
                        let text = `🖥️ <b>${t('Multiple open IDE windows detected:')}</b>\n\n`;
                        text += `${t('Select which workspace window you want to work with:')}`;
                        
                        const keyboard = new InlineKeyboard();
                        let btnCount = 0;
                        for (const win of activeWindows) {
                            if (win.workspacePath) {
                                const cleanName = win.projectName.replace(/\.code-workspace$/i, '');
                                const swId = `sw_scan_${btnCount++}_${Date.now()}`;
                                statusWindowPathCache.set(swId, win.workspacePath);
                                keyboard.text(`🔌 ${cleanName}`, `switch_window:${swId}`).row();
                            }
                        }
                        
                        bot.api.sendMessage(ch.chatId, text, {
                            parse_mode: 'HTML',
                            message_thread_id: ch.threadId,
                            reply_markup: keyboard
                        }).catch(e => logger.error('[background] Failed to send multiple windows selection:', e));
                    }
                }
            }
        } catch (e: any) {
            logger.debug(`[background] scanAndConnectNewWindows failed:`, e?.message || e);
        }
    };

    // Run background scanner every 15s
    setInterval(scanAndConnectNewWindows, 15000);

    logger.info('Starting Remoat Telegram bot...');

    // Graceful shutdown: close database on exit
    const closeDb = () => { try { db.close(); } catch (e) { logger.debug('[shutdown] db.close() failed:', e); } };
    process.on('exit', closeDb);
    process.on('SIGINT', () => { closeDb(); process.exit(0); });
    process.on('SIGTERM', () => { closeDb(); process.exit(0); });

    bot.catch((err) => {
        logger.error('Bot error:', err);
    });

    await bot.start({
        onStart: async (botInfo) => {
            logger.info(`Bot started as @${botInfo.username} | extractionMode=${config.extractionMode}`);
            try {
                await bot.api.setMyCommands([
                    { command: 'status', description: t('Bot Status') },
                    { command: 'workspace', description: t('Select a workspace') },
                    { command: 'new', description: t('Start a new chat session') },
                    { command: 'chat', description: t('Current session info') },
                    { command: 'chats', description: t('List and select chats') },
                    { command: 'history', description: t('Load history of the active session') },
                    { command: 'screenshot', description: t('Capture Antigravity screen') },
                    { command: 'stop', description: t('Interrupt active generation') },
                    { command: 'mirror', description: t('Set Mirror Mode') },
                    { command: 'autoaccept', description: t('Toggle auto-approve mode') },
                    { command: 'mode', description: t('Change execution mode') },
                    { command: 'model', description: t('Change LLM model') },
                    { command: 'help', description: t('Show all commands') },
                ]);
                logger.info('Telegram command menu registered successfully');
            } catch (err) {
                logger.error('Failed to register command menu:', err);
            }
        },
    });
};
