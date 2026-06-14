import { Api, InlineKeyboard, InputFile } from 'grammy';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { escapeHtml, formatForTelegram, splitTelegramHtml } from '../utils/telegramFormatter';
import { toTelegramInputFile, InboundImageAttachment } from '../utils/imageHandler';
import {
    CdpBridge,
    registerApprovalSessionChannel,
} from '../services/cdpBridgeManager';
import { ChannelContext } from '../services/messengerPort';
import { CdpService } from '../services/cdpService';
import { ModeService, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { ChatSessionService } from '../services/chatSessionService';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { TelegramTopicManager } from './telegramTopicManager';
import { TelegramAdapter } from './telegramAdapter';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { IdePromptRunner } from '../services/idePromptRunner';
import { channelKeyFromChannel } from '../services/workspaceResolver';
import { buildModelsUI } from '../ui/modelsUi';
import { getAntigravityCdpHint } from '../utils/pathUtils';
import { loadConfig } from '../utils/config';
import {
    telegramSentPrompts,
    userStopRequestedChannels,
    lastChoicesCache,
} from './botState';

export interface BotDependencies {
    chatSessionService: ChatSessionService;
    chatSessionRepo: ChatSessionRepository;
    topicManager: TelegramTopicManager;
    titleGenerator: TitleGeneratorService;
    modelService: ModelService;
    modeService: ModeService;
    workspaceBindingRepo: WorkspaceBindingRepository;
}

const channelKey = channelKeyFromChannel;

const PHASE_ICONS = {
    sending: '📡',
    thinking: '🧠',
    generating: '✍️',
    complete: '✅',
    timeout: '⏰',
    error: '❌',
} as const;

const MAX_OUTBOUND_GENERATED_IMAGES = 4;
const TELEGRAM_MSG_LIMIT = 4096;
const MAX_INLINE_CHUNKS = 5;

/** Convert Telegram HTML back to readable Markdown for .md file attachment */
function stripHtmlForFile(html: string): string {
    let text = html;
    // Code blocks: <pre><code class="language-X">...</code></pre> → ```X\n...\n```
    text = text.replace(
        /<pre>\s*<code\s+class="language-([^"]*)">([\s\S]*?)<\/code>\s*<\/pre>/gi,
        (_m, lang, content) => `\n\`\`\`${lang}\n${content}\n\`\`\`\n`,
    );
    // Code blocks: <pre>...</pre> → ```\n...\n```
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => `\n\`\`\`\n${content}\n\`\`\`\n`);
    // Inline code
    text = text.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
    // Bold
    text = text.replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**');
    // Italic
    text = text.replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*');
    // Strikethrough
    text = text.replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~');
    // Links
    text = text.replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, '[$2]($1)');
    // Blockquotes
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content) =>
        content.split('\n').map((l: string) => `> ${l}`).join('\n'),
    );
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode entities
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    // Collapse excessive newlines
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

export function createSerialTaskQueue(queueName: string, traceId: string): (task: () => Promise<void>, label?: string) => Promise<void> {
    let queue: Promise<void> = Promise.resolve();
    let taskSeq = 0;

    return (task: () => Promise<void>, label: string = 'queue-task'): Promise<void> => {
        taskSeq += 1;
        const seq = taskSeq;

        queue = queue.then(async () => {
            try { await task(); }
            catch (err: any) { logger.error(`[sendQueue:${traceId}:${queueName}] error #${seq} label=${label}:`, err?.message || err); }
        });

        return queue;
    };
}

export async function sendPromptToAntigravity(
    bridge: CdpBridge,
    channel: ChannelContext,
    prompt: string,
    cdp: CdpService,
    modeService: ModeService,
    modelService: ModelService,
    inboundImages: InboundImageAttachment[] = [],
    options?: {
        chatSessionService: ChatSessionService;
        chatSessionRepo: ChatSessionRepository;
        topicManager: TelegramTopicManager;
        titleGenerator: TitleGeneratorService;
    }
): Promise<void> {
    const api = (bridge.messenger as TelegramAdapter).getApi();
    const monitorTraceId = channelKey(channel);
    const enqueueGeneral = createSerialTaskQueue('general', monitorTraceId);
    const enqueueResponse = createSerialTaskQueue('response', monitorTraceId);
    const enqueueActivity = createSerialTaskQueue('activity', monitorTraceId);

    const sendMsg = async (text: string, replyMarkup?: any): Promise<number | null> => {
        try {
            const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
            const msg = await api.sendMessage(channel.chatId, truncated, {
                parse_mode: 'HTML',
                message_thread_id: channel.threadId,
                reply_markup: replyMarkup,
            });
            return msg.message_id;
        } catch (e) {
            logger.error('[sendMsg] Failed:', e);
            return null;
        }
    };

    const editMsg = async (msgId: number, text: string, replyMarkup?: any, maxRetries = 3): Promise<void> => {
        const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await api.editMessageText(channel.chatId, msgId, truncated, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                });
                break;
            } catch (e: any) {
                const desc = e?.description || e?.message || '';
                if (desc.includes('message is not modified')) {
                    break;
                }
                const retryAfter = e?.parameters?.retry_after;
                if (retryAfter) {
                    logger.error(`[editMsg] Too Many Requests: retry after ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, retryAfter * 1000));
                        continue;
                    }
                }
                logger.error('[editMsg] Failed:', desc);
                break;
            }
        }
    };

    const sendEmbed = (title: string, description: string): Promise<void> => enqueueGeneral(async () => {
        const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(description)}`;
        await sendMsg(text);
    }, 'send-embed');

    const sendChunkedResponse = async (title: string, footer: string, rawBody: string, isAlreadyHtml: boolean, replyMarkup?: any): Promise<void> => {
        const formattedBody = isAlreadyHtml ? rawBody : formatForTelegram(rawBody);
        const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        const fullMsg = `${titleLine}${formattedBody}${footerLine}`;

        if (fullMsg.length <= TELEGRAM_MSG_LIMIT) {
            await upsertLiveResponse(title, rawBody, footer, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml, skipTruncation: true, replyMarkup });
            return;
        }

        const bodyChunks = splitTelegramHtml(formattedBody, TELEGRAM_MSG_LIMIT - 200);
        const inlineCount = Math.min(bodyChunks.length, MAX_INLINE_CHUNKS);
        const hasFile = bodyChunks.length > MAX_INLINE_CHUNKS;
        const total = hasFile ? inlineCount : bodyChunks.length;

        for (let pi = 0; pi < inlineCount; pi++) {
            const partLabel = hasFile ? `(${pi + 1}/${inlineCount}+file)` : `(${pi + 1}/${total})`;
            const isLast = (pi === inlineCount - 1);
            const currentMarkup = isLast && !hasFile ? replyMarkup : undefined;
            if (pi === 0) {
                const firstTitle = title ? `${title} ${partLabel}` : partLabel;
                await upsertLiveResponse(firstTitle, bodyChunks[pi], footer, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml: true, skipTruncation: true, replyMarkup: currentMarkup });
            } else {
                const partFooter = footer ? `${escapeHtml(footer)} ${partLabel}` : partLabel;
                await sendMsg(`${bodyChunks[pi]}\n\n<i>${partFooter}</i>`, currentMarkup);
            }
        }

        if (hasFile) {
            try {
                const fileContent = stripHtmlForFile(formattedBody);
                const buf = Buffer.from(fileContent, 'utf-8');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                await api.sendDocument(channel.chatId, new InputFile(buf, `response-${timestamp}.md`), {
                    caption: `📄 Full response (${rawBody.length} chars)`,
                    message_thread_id: channel.threadId,
                    reply_markup: replyMarkup,
                });
            } catch (e) { logger.error('[sendPrompt] Failed to send response file:', e); }
        }
    };

    if (!cdp.isConnected()) {
        await sendEmbed(
            `${PHASE_ICONS.error} Connection Error`,
            `Not connected to Antigravity.\nStart with \`${getAntigravityCdpHint(9223)}\`, then send a message to auto-connect.`,
        );
        return;
    }

    const localMode = modeService.getCurrentMode();
    const modeName = MODE_UI_NAMES[localMode] || localMode;
    const currentModel = (await cdp.getCurrentModel()) || modelService.getCurrentModel();
    const modelLabel = `${currentModel}`;

    const stopKeyboard = new InlineKeyboard().text('⏹️ Stop', 'stop_generation');

    let liveActivityMsgId: number | null = null;
    try {
        const sendingText = `<b>📡 ${escapeHtml(modeName)} · ${escapeHtml(modelLabel)}</b>\n\n<i>Sending...</i>`;
        const sendingMsg = await api.sendMessage(channel.chatId, sendingText, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: stopKeyboard,
        });
        liveActivityMsgId = sendingMsg.message_id;
    } catch (e) { logger.error('[sendPrompt] Failed to send initial status:', e); }

    let liveResponseMsgId: number | null = null;
    let lastLiveResponseKey = '';
    let lastLiveActivityKey = '';
    let liveResponseUpdateVersion = 0;
    let liveActivityUpdateVersion = 0;
    const LIVE_RESPONSE_MAX_LEN = 3800;

    const upsertLiveResponse = (title: string, rawText: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean; isAlreadyHtml?: boolean; skipTruncation?: boolean; replyMarkup?: any }): Promise<void> =>
        enqueueResponse(async () => {
            if (opts?.skipWhenFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveResponseUpdateVersion) return;
            const normalized = (rawText || '').trim();
            const body = normalized
                ? (opts?.isAlreadyHtml ? normalized : formatForTelegram(normalized))
                : t('Generating...');
            const truncated = (!opts?.skipTruncation && body.length > LIVE_RESPONSE_MAX_LEN)
                ? '...(beginning truncated)\n' + body.slice(-LIVE_RESPONSE_MAX_LEN + 30)
                : body;
            const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
            const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
            const text = `${titleLine}${truncated}${footerLine}`;

            const renderKey = `${title}|${rawText.slice(0, 200)}|${footer}|${opts?.replyMarkup ? 'with-markup' : 'no-markup'}`;
            if (renderKey === lastLiveResponseKey && liveResponseMsgId) return;
            lastLiveResponseKey = renderKey;

            if (liveResponseMsgId) {
                await editMsg(liveResponseMsgId, text, opts?.replyMarkup);
            } else {
                liveResponseMsgId = await sendMsg(text, opts?.replyMarkup);
            }
        }, 'upsert-response');

    const setProgressMessage = (htmlContent: string): Promise<void> =>
        enqueueActivity(async () => {
            lastLiveActivityKey = htmlContent.slice(0, 200);
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, htmlContent, undefined);
            } else {
                liveActivityMsgId = await sendMsg(htmlContent, undefined);
            }
        }, 'upsert-activity');

    let resolveMonitorDone!: () => void;
    const monitorDone = new Promise<void>(resolve => { resolveMonitorDone = resolve; });

    const projectName = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace;
    const planningDetector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;

    try {
        cdp.setTelegramInitiated(true);
        await IdePromptRunner.runPrompt(
            cdp,
            prompt,
            inboundImages.map(img => img.localPath),
            {
                modelLabel,
                modeName,
                isStopRequested: () => userStopRequestedChannels.has(channelKey(channel)),
                clearStopRequest: () => { userStopRequestedChannels.delete(channelKey(channel)); },
                planningDetector,
                maxOutboundImages: MAX_OUTBOUND_GENERATED_IMAGES
            },
            {
                onActivityProgress: async ({ title, body, footer, isFinalized }) => {
                    enqueueActivity(async () => {
                        if (isFinalized) {
                            const text = `<b>${PHASE_ICONS.complete} ${escapeHtml(modelLabel)} · ${footer}</b>\n\n${body}`;
                            lastLiveActivityKey = text.slice(0, 200);
                            if (liveActivityMsgId) {
                                await editMsg(liveActivityMsgId, text, undefined);
                            } else {
                                liveActivityMsgId = await sendMsg(text, undefined);
                            }
                        } else {
                            const text = `<b>${escapeHtml(title)}</b>\n\n${body}\n\n<i>${escapeHtml(footer)}</i>`;
                            const bodySnap = body.length + '|' + title + '|' + footer;
                            if (bodySnap === lastLiveActivityKey && liveActivityMsgId) return;
                            lastLiveActivityKey = bodySnap;
                            await editMsg(liveActivityMsgId!, text, stopKeyboard);
                        }
                    });
                },
                onLiveResponseUpdate: async ({ title, body, footer, isAlreadyHtml, isFinalized }) => {
                    await upsertLiveResponse(title, body, footer, {
                        isAlreadyHtml,
                        skipWhenFinalized: isFinalized
                    });
                },
                onComplete: async ({ finalText, isHtml, choices, elapsedSeconds, generatedImages }) => {
                    try {
                        const replyKeyboard = new InlineKeyboard();
                        if (choices && choices.length > 0) {
                            const proj = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace || 'default';
                            lastChoicesCache.set(channelKey(channel), choices);
                            choices.forEach((choice, idx) => {
                                replyKeyboard.text(choice, `ai_choice:${proj}:${idx}`);
                                replyKeyboard.row();
                            });
                        }
                        replyKeyboard.text('↩️ ' + t('Undo'), 'undo_last');

                        liveResponseUpdateVersion += 1;
                        if (finalText && finalText.trim().length > 0) {
                            const footer = `⏱️ ${elapsedSeconds}s`;
                            await sendChunkedResponse('', footer, finalText, isHtml, replyKeyboard);
                        } else {
                            await upsertLiveResponse(`${PHASE_ICONS.complete} Complete`, t('Failed to extract response. Use /screenshot to verify.'), `⏱️ ${elapsedSeconds}s`, { expectedVersion: liveResponseUpdateVersion, replyMarkup: replyKeyboard });
                        }

                        if (options) {
                            try {
                                const sessionInfo = await options.chatSessionService.getCurrentSessionInfo(cdp);
                                if (sessionInfo && sessionInfo.hasActiveChat && sessionInfo.title && sessionInfo.title !== t('(Untitled)')) {
                                    const session = options.chatSessionRepo.findByChannelId(channelKey(channel));
                                    const pName = session
                                        ? bridge.pool.extractProjectName(session.workspacePath)
                                        : cdp.getCurrentWorkspaceName();
                                    if (pName) {
                                        registerApprovalSessionChannel(bridge, pName, sessionInfo.title, channel);
                                    }

                                    if (session && session.displayName !== sessionInfo.title) {
                                        const newName = options.titleGenerator.sanitizeForChannelName(sessionInfo.title);
                                        const formattedName = `${session.sessionNumber}-${newName}`;
                                        const threadId = session.channelId.includes(':')
                                            ? Number(session.channelId.split(':')[1])
                                            : undefined;
                                        if (threadId) {
                                            try {
                                                options.topicManager.setChatId(Number(session.channelId.split(':')[0]));
                                                await options.topicManager.renameTopic(threadId, formattedName);
                                            } catch (e) { logger.debug('[Rename] Topic rename optional, failed:', e); }
                                        }
                                        options.chatSessionRepo.updateDisplayName(channelKey(channel), sessionInfo.title);
                                    }
                                }
                            } catch (e) { logger.error('[Rename] Failed:', e); }
                        }

                        for (let i = 0; i < generatedImages.length; i++) {
                            const file = await toTelegramInputFile(generatedImages[i], i);
                            if (file) {
                                try {
                                    await api.sendPhoto(channel.chatId, new InputFile(file.buffer, file.name), {
                                        caption: `🖼️ Generated image (${i + 1}/${generatedImages.length})`,
                                        message_thread_id: channel.threadId,
                                    });
                                } catch (e) { logger.error('[sendGeneratedImages] Failed:', e); }
                            }
                        }
                    } catch (error) {
                        logger.error(`[sendPrompt:${monitorTraceId}] onComplete failed:`, error);
                    } finally {
                        resolveMonitorDone();
                    }
                },
                onQuotaReached: async ({ elapsedSeconds, modelLabel, progressBody }) => {
                    try {
                        liveActivityUpdateVersion += 1;
                        await setProgressMessage(`<b>⚠️ ${escapeHtml(modelLabel)} · Quota Reached</b>\n\n${progressBody}\n\n<i>⏱️ ${elapsedSeconds}s</i>`);
                        liveResponseUpdateVersion += 1;
                        await upsertLiveResponse('⚠️ Quota Reached', 'Model quota limit reached. Please wait or switch to a different model.', `⏱️ ${elapsedSeconds}s`, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml: false, skipTruncation: true });

                        try {
                            const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                            if (payload) {
                                await api.sendMessage(channel.chatId, payload.text, { parse_mode: 'HTML', message_thread_id: channel.threadId, reply_markup: payload.keyboard });
                            }
                        } catch (e) { logger.error('[Quota] Failed to send model selection UI:', e); }
                    } finally {
                        resolveMonitorDone();
                    }
                },
                onTimeout: async ({ elapsedSeconds, payloadText, isHtml }) => {
                    try {
                        const undoKeyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');
                        liveResponseUpdateVersion += 1;
                        await sendChunkedResponse(`${PHASE_ICONS.timeout} Timeout`, `⏱️ ${elapsedSeconds}s`, payloadText, isHtml, undoKeyboard);
                        liveActivityUpdateVersion += 1;
                        await setProgressMessage(`<b>${PHASE_ICONS.timeout} ${escapeHtml(modelLabel)} · ${elapsedSeconds}s</b>`);
                    } finally {
                        resolveMonitorDone();
                    }
                },
                onError: async (errorMsg) => {
                    try {
                        await sendEmbed(`${PHASE_ICONS.error} Error`, t(`Error occurred during processing: ${errorMsg}`));
                    } finally {
                        resolveMonitorDone();
                    }
                }
            }
        );

        await monitorDone;
    } finally {
        cdp.setTelegramInitiated(false);
    }
}

export async function mirrorResponseToTelegram(
    bridge: CdpBridge,
    channel: ChannelContext,
    cdp: CdpService,
    userPrompt: string,
    options: BotDependencies
): Promise<void> {
    const api = (bridge.messenger as TelegramAdapter).getApi();
    const monitorTraceId = channelKey(channel);
    const enqueueResponse = createSerialTaskQueue('response', monitorTraceId);
    const enqueueActivity = createSerialTaskQueue('activity', monitorTraceId);
    const workspaceName = cdp.getCurrentWorkspaceName();

    const shouldSkipMirroring = (): boolean => {
        const appConf = loadConfig();
        const mirrorMode = appConf.mirrorMode || (appConf.onlyActiveWorkspaceMessages ? 'active' : 'all');

        if (mirrorMode === 'active') {
            const conf = options.workspaceBindingRepo ? options.workspaceBindingRepo.findByChannelId(channelKey(channel)) : null;
            if (!conf) return false;
            const activeProjectName = bridge.pool.extractProjectName(conf.workspacePath);
            if (activeProjectName !== workspaceName) {
                logger.debug(`[mirror:${workspaceName}] mirrorMode is active but this is not the active workspace (${activeProjectName}), skipping.`);
                return true;
            }
        }
        return false;
    };

    const sendMsg = async (text: string, replyMarkup?: any): Promise<number | null> => {
        try {
            if (shouldSkipMirroring()) return null;
            const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
            const msg = await api.sendMessage(channel.chatId, truncated, {
                parse_mode: 'HTML',
                message_thread_id: channel.threadId,
                reply_markup: replyMarkup,
            });
            return msg.message_id;
        } catch (e) {
            logger.error('[mirror:sendMsg] Failed:', e);
            return null;
        }
    };

    const editMsg = async (msgId: number, text: string, replyMarkup?: any, maxRetries = 3): Promise<void> => {
        if (shouldSkipMirroring()) return;
        const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await api.editMessageText(channel.chatId, msgId, truncated, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                });
                break;
            } catch (e: any) {
                const desc = e?.description || e?.message || '';
                if (desc.includes('message is not modified')) {
                    break;
                }
                const retryAfter = e?.parameters?.retry_after;
                if (retryAfter) {
                    logger.error(`[mirror:editMsg] Too Many Requests: retry after ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, retryAfter * 1000));
                        continue;
                    }
                }
                logger.error('[mirror:editMsg] Failed:', desc);
                break;
            }
        }
    };

    const sendChunkedResponse = async (title: string, footer: string, rawBody: string, isAlreadyHtml: boolean, replyMarkup?: any): Promise<void> => {
        const formattedBody = isAlreadyHtml ? rawBody : formatForTelegram(rawBody);
        const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        const fullMsg = `${titleLine}${formattedBody}${footerLine}`;

        if (fullMsg.length <= TELEGRAM_MSG_LIMIT) {
            await upsertLiveResponse(title, rawBody, footer, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml, skipTruncation: true, replyMarkup });
            return;
        }

        const bodyChunks = splitTelegramHtml(formattedBody, TELEGRAM_MSG_LIMIT - 200);
        const inlineCount = Math.min(bodyChunks.length, MAX_INLINE_CHUNKS);
        const hasFile = bodyChunks.length > MAX_INLINE_CHUNKS;
        const total = hasFile ? inlineCount : bodyChunks.length;

        for (let pi = 0; pi < inlineCount; pi++) {
            const partLabel = hasFile ? `(${pi + 1}/${inlineCount}+file)` : `(${pi + 1}/${total})`;
            const isLast = (pi === inlineCount - 1);
            const currentMarkup = isLast && !hasFile ? replyMarkup : undefined;
            if (pi === 0) {
                const firstTitle = title ? `${title} ${partLabel}` : partLabel;
                await upsertLiveResponse(firstTitle, bodyChunks[pi], footer, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml: true, skipTruncation: true, replyMarkup: currentMarkup });
            } else {
                const partFooter = footer ? `${escapeHtml(footer)} ${partLabel}` : partLabel;
                await sendMsg(`${bodyChunks[pi]}\n\n<i>${partFooter}</i>`, currentMarkup);
            }
        }

        if (hasFile) {
            try {
                const fileContent = stripHtmlForFile(formattedBody);
                const buf = Buffer.from(fileContent, 'utf-8');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                await api.sendDocument(channel.chatId, new InputFile(buf, `response-${timestamp}.md`), {
                    caption: `📄 Full response (${rawBody.length} chars)`,
                    message_thread_id: channel.threadId,
                    reply_markup: replyMarkup,
                });
            } catch (e) { logger.error('[mirror] Failed to send response file:', e); }
        }
    };

    if (!cdp.isConnected()) return;
    if (shouldSkipMirroring()) return;

    const currentModel = (await cdp.getCurrentModel()) || options.modelService.getCurrentModel();
    const modelLabel = `${currentModel}`;
    const stopKeyboard = new InlineKeyboard().text('⏹️ Stop', 'stop_generation');

    const cleanProjName = workspaceName ? workspaceName.replace(/\.code-workspace$/i, '') : '';
    const ideLabel = cleanProjName ? `IDE: ${cleanProjName}` : 'IDE';

    let liveActivityMsgId: number | null = null;
    try {
        const generatingText = `<b>📡 [${ideLabel}] · ${escapeHtml(modelLabel)}</b>\n\n<i>Generating...</i>`;
        const generatingMsg = await api.sendMessage(channel.chatId, generatingText, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: stopKeyboard,
        });
        liveActivityMsgId = generatingMsg.message_id;
    } catch (e) { logger.error('[mirror] Failed to send initial status:', e); }

    let liveResponseMsgId: number | null = null;
    let lastLiveResponseKey = '';
    let lastLiveActivityKey = '';
    let liveResponseUpdateVersion = 0;
    let liveActivityUpdateVersion = 0;
    const LIVE_RESPONSE_MAX_LEN = 3800;

    const upsertLiveResponse = (title: string, rawText: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean; isAlreadyHtml?: boolean; skipTruncation?: boolean; replyMarkup?: any }): Promise<void> =>
        enqueueResponse(async () => {
            if (shouldSkipMirroring()) return;
            if (opts?.skipWhenFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveResponseUpdateVersion) return;
            const normalized = (rawText || '').trim();
            const body = normalized
                ? (opts?.isAlreadyHtml ? normalized : formatForTelegram(normalized))
                : t('Generating...');
            const truncated = (!opts?.skipTruncation && body.length > LIVE_RESPONSE_MAX_LEN)
                ? '...(beginning truncated)\n' + body.slice(-LIVE_RESPONSE_MAX_LEN + 30)
                : body;
            const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
            const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
            const text = `${titleLine}${truncated}${footerLine}`;

            const renderKey = `${title}|${rawText.slice(0, 200)}|${footer}|${opts?.replyMarkup ? 'with-markup' : 'no-markup'}`;
            if (renderKey === lastLiveResponseKey && liveResponseMsgId) return;
            lastLiveResponseKey = renderKey;

            if (liveResponseMsgId) {
                await editMsg(liveResponseMsgId, text, opts?.replyMarkup);
            } else {
                liveResponseMsgId = await sendMsg(text, opts?.replyMarkup);
            }
        }, 'upsert-response');

    const setProgressMessage = (htmlContent: string): Promise<void> =>
        enqueueActivity(async () => {
            if (shouldSkipMirroring()) return;
            lastLiveActivityKey = htmlContent.slice(0, 200);
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, htmlContent, undefined);
            } else {
                liveActivityMsgId = await sendMsg(htmlContent, undefined);
            }
        }, 'upsert-activity');

    let resolveMonitorDone!: () => void;
    const monitorDone = new Promise<void>(resolve => { resolveMonitorDone = resolve; });

    await IdePromptRunner.monitorResponse(
        cdp,
        userPrompt,
        {
            modelLabel,
            modeName: '',
            isStopRequested: () => userStopRequestedChannels.has(channelKey(channel)),
            clearStopRequest: () => { userStopRequestedChannels.delete(channelKey(channel)); },
            ideLabel,
            maxOutboundImages: MAX_OUTBOUND_GENERATED_IMAGES
        },
        {
            onActivityProgress: async ({ title, body, footer, isFinalized }) => {
                enqueueActivity(async () => {
                    if (shouldSkipMirroring()) return;
                    if (isFinalized) {
                        const text = `<b>${PHASE_ICONS.complete} ${escapeHtml(modelLabel)} · ${footer}</b>\n\n${body}`;
                        lastLiveActivityKey = text.slice(0, 200);
                        if (liveActivityMsgId) {
                            await editMsg(liveActivityMsgId, text, undefined);
                        } else {
                            liveActivityMsgId = await sendMsg(text, undefined);
                        }
                    } else {
                        const text = `<b>${escapeHtml(title)}</b>\n\n${body}\n\n<i>${escapeHtml(footer)}</i>`;
                        const bodySnap = body.length + '|' + title + '|' + footer;
                        if (bodySnap === lastLiveActivityKey && liveActivityMsgId) return;
                        lastLiveActivityKey = bodySnap;
                        await editMsg(liveActivityMsgId!, text, stopKeyboard);
                    }
                });
            },
            onLiveResponseUpdate: async ({ title, body, footer, isAlreadyHtml, isFinalized }) => {
                await upsertLiveResponse(title, body, footer, {
                    isAlreadyHtml,
                    skipWhenFinalized: isFinalized
                });
            },
            onComplete: async ({ finalText, isHtml, choices, elapsedSeconds, generatedImages }) => {
                try {
                    if (shouldSkipMirroring()) return;
                    const replyKeyboard = new InlineKeyboard();
                    if (choices && choices.length > 0) {
                        const proj = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace || 'default';
                        lastChoicesCache.set(channelKey(channel), choices);
                        choices.forEach((choice, idx) => {
                            replyKeyboard.text(choice, `ai_choice:${proj}:${idx}`);
                            replyKeyboard.row();
                        });
                    }
                    replyKeyboard.text('↩️ ' + t('Undo'), 'undo_last');

                    liveResponseUpdateVersion += 1;
                    if (finalText && finalText.trim().length > 0) {
                        const footer = `⏱️ ${elapsedSeconds}s`;
                        await sendChunkedResponse('', footer, finalText, isHtml, replyKeyboard);
                    } else {
                        await upsertLiveResponse(`${PHASE_ICONS.complete} Complete`, t('Failed to extract response. Use /screenshot to verify.'), `⏱️ ${elapsedSeconds}s`, { expectedVersion: liveResponseUpdateVersion, replyMarkup: replyKeyboard });
                    }

                    try {
                        const sessionInfo = await options.chatSessionService.getCurrentSessionInfo(cdp);
                        if (sessionInfo && sessionInfo.hasActiveChat && sessionInfo.title && sessionInfo.title !== t('(Untitled)')) {
                            const session = options.chatSessionRepo.findByChannelId(channelKey(channel));
                            const pName = session
                                ? bridge.pool.extractProjectName(session.workspacePath)
                                : cdp.getCurrentWorkspaceName();
                            if (pName) {
                                registerApprovalSessionChannel(bridge, pName, sessionInfo.title, channel);
                            }

                            if (session && session.displayName !== sessionInfo.title) {
                                const newName = options.titleGenerator.sanitizeForChannelName(sessionInfo.title);
                                const formattedName = `${session.sessionNumber}-${newName}`;
                                const threadId = session.channelId.includes(':')
                                    ? Number(session.channelId.split(':')[1])
                                    : undefined;
                                if (threadId) {
                                    try {
                                        options.topicManager.setChatId(Number(session.channelId.split(':')[0]));
                                        await options.topicManager.renameTopic(threadId, formattedName);
                                    } catch (e) { logger.debug('[Rename] Topic rename optional, failed:', e); }
                                }
                                options.chatSessionRepo.updateDisplayName(channelKey(channel), sessionInfo.title);
                            }
                        }
                    } catch (e) { logger.error('[mirror] Failed to sync session title:', e); }

                    for (let i = 0; i < generatedImages.length; i++) {
                        const file = await toTelegramInputFile(generatedImages[i], i);
                        if (file) {
                            try {
                                await api.sendPhoto(channel.chatId, new InputFile(file.buffer, file.name), {
                                    caption: `🖼️ Generated image (${i + 1}/${generatedImages.length})`,
                                    message_thread_id: channel.threadId,
                                });
                            } catch (e) { logger.error('[mirror:sendImages] Failed:', e); }
                        }
                    }
                } catch (error) {
                    logger.error(`[mirror:${monitorTraceId}] onComplete failed:`, error);
                } finally {
                    resolveMonitorDone();
                }
            },
            onQuotaReached: async ({ elapsedSeconds, modelLabel, progressBody }) => {
                try {
                    liveActivityUpdateVersion += 1;
                    await setProgressMessage(`<b>⚠️ ${escapeHtml(modelLabel)} · Quota Reached</b>\n\n${progressBody}\n\n<i>⏱️ ${elapsedSeconds}s</i>`);
                    liveResponseUpdateVersion += 1;
                    await upsertLiveResponse('⚠️ Quota Reached', 'Model quota limit reached. Please wait or switch to a different model.', `⏱️ ${elapsedSeconds}s`, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml: false, skipTruncation: true });

                    try {
                        const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                        if (payload) {
                            await api.sendMessage(channel.chatId, payload.text, { parse_mode: 'HTML', message_thread_id: channel.threadId, reply_markup: payload.keyboard });
                        }
                    } catch (e) { logger.error('[Quota] Failed to send model selection UI:', e); }
                } finally {
                    resolveMonitorDone();
                }
            },
            onTimeout: async ({ elapsedSeconds, payloadText, isHtml }) => {
                try {
                    const undoKeyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');
                    liveResponseUpdateVersion += 1;
                    await sendChunkedResponse(`${PHASE_ICONS.timeout} Timeout`, `⏱️ ${elapsedSeconds}s`, payloadText, isHtml, undoKeyboard);
                    liveActivityUpdateVersion += 1;
                    await setProgressMessage(`<b>${PHASE_ICONS.timeout} ${escapeHtml(modelLabel)} · ${elapsedSeconds}s</b>`);
                } finally {
                    resolveMonitorDone();
                }
            },
            onError: async (errorMsg) => {
                try {
                    const embedText = `<b>${PHASE_ICONS.error} Error</b>\n\n${escapeHtml(t(`Error occurred during processing: ${errorMsg}`))}`;
                    await api.sendMessage(channel.chatId, embedText, { parse_mode: 'HTML', message_thread_id: channel.threadId });
                } finally {
                    resolveMonitorDone();
                }
            }
        }
    );

    await monitorDone;
}
