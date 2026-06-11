import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import Database from 'better-sqlite3';
import * as https from 'https';
import path from 'path';
import WebSocket from 'ws';
// @ts-ignore
import fetch from 'node-fetch';

import { t, initI18n, Language } from '../utils/i18n';
import { logger } from '../utils/logger';
import type { LogLevel } from '../utils/logger';
import { loadConfig, resolveResponseDeliveryMode } from '../utils/config';
import { ConfigLoader } from '../utils/configLoader';
import { parseMessageContent } from '../commands/messageParser';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { CleanupCommandHandler, CLEANUP_ARCHIVE_BTN, CLEANUP_DELETE_BTN, CLEANUP_CANCEL_BTN } from '../commands/cleanupCommandHandler';

import { ModeService, AVAILABLE_MODES, MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceService, RecentWorkspace } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';

import { CdpService } from '../services/cdpService';
import { ChatSessionService } from '../services/chatSessionService';
import { ResponseMonitor, RESPONSE_SELECTORS } from '../services/responseMonitor';
import { buildClickScript } from '../services/approvalDetector';
import { ensureAntigravityRunning } from '../services/antigravityLauncher';
import { getAntigravityCdpHint, isTitleMatch } from '../utils/pathUtils';
import { CDP_PORTS } from '../utils/cdpPorts';
import { AutoAcceptService, AutoAcceptSettings } from '../services/autoAcceptService';
import { PromptDispatcher } from '../services/promptDispatcher';
import {
    CdpBridge,
    TelegramChannel,
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

const telegramSentPrompts = new Set<string>();

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

const userStopRequestedChannels = new Set<string>();
const statusWindowPathCache = new Map<string, string>();
const restoreWindowPathCache = new Map<string, string>();
const promptSelectionSentChannels = new Set<string>();
const lastChoicesCache = new Map<string, string[]>();

// Interrupt state is managed by ../services/interruptState.ts
// (addPendingInterrupt, drainPendingInterrupts, etc.)

/** Channels where the user is expected to type plan edit instructions */
const planEditPendingChannels = new Map<string, { projectName: string }>();
/** Cached plan content pages per channel */
const planContentCache = new Map<string, string[]>();

/** Re-export for use throughout this file */
const channelKey = channelKeyFromChannel;

function createSerialTaskQueue(queueName: string, traceId: string): (task: () => Promise<void>, label?: string) => Promise<void> {
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

async function sendPromptToAntigravity(
    bridge: CdpBridge,
    channel: TelegramChannel,
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
    const api = bridge.botApi!;
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

    /** Send a potentially long response, splitting into chunks and attaching a .md file if needed. */
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

    // Initialize live progress message (replaces separate "Sending" embed)
    let liveActivityMsgId: number | null = null;
    try {
        const sendingText = `<b>${PHASE_ICONS.sending} ${escapeHtml(modeName)} · ${escapeHtml(modelLabel)}</b>\n\n<i>Sending...</i>`;
        const sendingMsg = await api.sendMessage(channel.chatId, sendingText, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: stopKeyboard,
        });
        liveActivityMsgId = sendingMsg.message_id;
    } catch (e) { logger.error('[sendPrompt] Failed to send initial status:', e); }

    let isFinalized = false;
    let elapsedTimer: ReturnType<typeof setInterval> | null = null;
    let lastProgressText = '';
    const LIVE_RESPONSE_MAX_LEN = 3800;
    const MAX_PROGRESS_BODY = 3500;
    const MAX_PROGRESS_ENTRIES = 60;
    let liveResponseMsgId: number | null = null;
    let lastLiveResponseKey = '';
    let lastLiveActivityKey = '';
    let liveResponseUpdateVersion = 0;
    let liveActivityUpdateVersion = 0;

    // --- Ordered progress event stream ---
    interface ProgressEntry { kind: 'thought' | 'thought-content' | 'activity'; text: string; }
    const progressLog: ProgressEntry[] = [];
    let thinkingActive = false;
    const thinkingContentParts: string[] = [];
    let lastThoughtLabel = '';

    /** Check if text is junk (numbers, very short, not meaningful) */
    const isJunkEntry = (text: string): boolean => {
        const t = text.trim();
        if (t.length < 5) return true;
        if (/^\d+$/.test(t)) return true;
        // Single word under 8 chars without context (e.g. "Analyzed" alone)
        if (!/\s/.test(t) && t.length < 8) return true;
        return false;
    };

    /** Format a single activity line — collapse multi-line text into one line */
    const formatActivityLine = (raw: string): string => {
        // Collapse newlines into spaces so file references after verbs aren't lost
        // e.g. "Analyzed\npackage.json#L1-75" → "Analyzed package.json#L1-75"
        const collapsed = (raw || '').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (!collapsed || isJunkEntry(collapsed)) return '';
        return escapeHtml(collapsed.slice(0, 120));
    };

    /** Trim progress log to stay within size limits */
    const trimProgressLog = (): void => {
        while (progressLog.length > MAX_PROGRESS_ENTRIES) progressLog.shift();
    };

    /** Build the progress message body from the ordered event stream */
    const buildProgressBody = (): string => {
        const lines: string[] = [];
        for (const e of progressLog) {
            switch (e.kind) {
                case 'thought':
                    lines.push(`💭 <i>${escapeHtml(e.text)}</i>`);
                    break;
                case 'thought-content':
                    lines.push(`<i>${escapeHtml(e.text)}</i>`);
                    break;
                case 'activity':
                    lines.push(e.text); // already HTML-escaped
                    break;
            }
        }
        if (thinkingActive) {
            lines.push('💭 <i>Thinking...</i>');
        }
        // Use \n\n for spacing between entries (like Antigravity's line gap)
        let body = lines.join('\n\n');
        // Trim from beginning if too long, keeping most recent events
        if (body.length > MAX_PROGRESS_BODY) {
            body = '...\n\n' + body.slice(-MAX_PROGRESS_BODY + 5);
        }
        return body || '<i>Generating...</i>';
    };

    /** Build full progress message with title + body + footer */
    const buildProgressMessage = (title: string, footer: string): string => {
        const body = buildProgressBody();
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        return `<b>${escapeHtml(title)}</b>\n\n${body}${footerLine}`;
    };

    const buildLiveResponseText = (title: string, rawText: string, footer: string, isAlreadyHtml = false, skipTruncation = false): string => {
        const normalized = (rawText || '').trim();
        const body = normalized
            ? (isAlreadyHtml ? normalized : formatForTelegram(normalized))
            : t('Generating...');
        const truncated = (!skipTruncation && body.length > LIVE_RESPONSE_MAX_LEN)
            ? '...(beginning truncated)\n' + body.slice(-LIVE_RESPONSE_MAX_LEN + 30)
            : body;
        const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        return `${titleLine}${truncated}${footerLine}`;
    };

    const upsertLiveResponse = (title: string, rawText: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean; isAlreadyHtml?: boolean; skipTruncation?: boolean; replyMarkup?: any }): Promise<void> =>
        enqueueResponse(async () => {
            if (opts?.skipWhenFinalized && isFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveResponseUpdateVersion) return;
            const text = buildLiveResponseText(title, rawText, footer, opts?.isAlreadyHtml, opts?.skipTruncation);
            const renderKey = `${title}|${rawText.slice(0, 200)}|${footer}|${opts?.replyMarkup ? 'with-markup' : 'no-markup'}`;
            if (renderKey === lastLiveResponseKey && liveResponseMsgId) return;
            lastLiveResponseKey = renderKey;

            if (liveResponseMsgId) {
                await editMsg(liveResponseMsgId, text, opts?.replyMarkup);
            } else {
                liveResponseMsgId = await sendMsg(text, opts?.replyMarkup);
            }
        }, 'upsert-response');

    /** Refresh progress message using the ordered event stream */
    const refreshProgress = (title: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean }): Promise<void> =>
        enqueueActivity(async () => {
            if (opts?.skipWhenFinalized && isFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
            const text = buildProgressMessage(title, footer);
            // Use progress body hash for dedup
            const bodySnap = progressLog.length + '|' + thinkingActive + '|' + title + '|' + footer;
            if (bodySnap === lastLiveActivityKey && liveActivityMsgId) return;
            lastLiveActivityKey = bodySnap;

            const keyboard = isFinalized ? undefined : stopKeyboard;
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, text, keyboard);
            } else {
                liveActivityMsgId = await sendMsg(text, keyboard);
            }
        }, 'upsert-activity');

    /** Direct message update for special cases (completion, quota, timeout) */
    const setProgressMessage = (htmlContent: string, opts?: { expectedVersion?: number }): Promise<void> =>
        enqueueActivity(async () => {
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
            lastLiveActivityKey = htmlContent.slice(0, 200);
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, htmlContent, undefined);
            } else {
                liveActivityMsgId = await sendMsg(htmlContent, undefined);
            }
        }, 'upsert-activity');

    const sendGeneratedImages = async (responseText: string): Promise<void> => {
        const imageIntentPattern = /(image|images|png|jpg|jpeg|gif|webp|illustration|diagram|render)/i;
        const imageUrlPattern = /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp)/i;
        if (!imageIntentPattern.test(prompt) && !responseText.includes('![') && !imageUrlPattern.test(responseText)) return;

        const extracted = await cdp.extractLatestResponseImages(MAX_OUTBOUND_GENERATED_IMAGES);
        if (extracted.length === 0) return;

        for (let i = 0; i < extracted.length; i++) {
            const file = await toTelegramInputFile(extracted[i], i);
            if (file) {
                try {
                    await api.sendPhoto(channel.chatId, new InputFile(file.buffer, file.name), {
                        caption: `🖼️ Generated image (${i + 1}/${extracted.length})`,
                        message_thread_id: channel.threadId,
                    });
                } catch (e) { logger.error('[sendGeneratedImages] Failed:', e); }
            }
        }
    };

    const tryEmergencyExtractText = async (): Promise<string> => {
        try {
            const contextId = cdp.getPrimaryContextId();
            const expression = `(() => {
                const panel = document.querySelector('.antigravity-agent-side-panel');
                const scope = panel || document;
                const candidateSelectors = ['.rendered-markdown', '.leading-relaxed.select-text', '.flex.flex-col.gap-y-3', '[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[class*="assistant-message"]', '[class*="message-content"]', '[class*="markdown-body"]', '.prose'];
                const looksLikeActivity = (text) => { const n = (text || '').trim().toLowerCase(); if (!n) return true; return /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|analyzed|read|wrote|ran)/i.test(n) && n.length <= 220; };
                const clean = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
                const candidates = []; const seen = new Set();
                for (const selector of candidateSelectors) { const nodes = scope.querySelectorAll(selector); for (const node of nodes) { if (!node || seen.has(node)) continue; seen.add(node); candidates.push(node); } }
                for (let i = candidates.length - 1; i >= 0; i--) { const node = candidates[i]; const text = clean(node.innerText || node.textContent || ''); if (!text || text.length < 20) continue; if (looksLikeActivity(text)) continue; if (/^(good|bad)$/i.test(text)) continue; return text; }
                return '';
            })()`;
            const callParams: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
            if (contextId !== null) callParams.contextId = contextId;
            const res = await cdp.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            return typeof value === 'string' ? value.trim() : '';
        } catch (e) { logger.debug('[tryEmergencyExtractText] Failed:', e); return ''; }
    };

    let monitor: ResponseMonitor | null = null;

    // Completion gate: holds the PromptDispatcher lock until onComplete/onTimeout fires.
    // Without this, monitor.start() resolves immediately (it schedules polling via setTimeout),
    // causing the dispatcher to release the lock while Antigravity is still generating —
    // allowing a second prompt to inject concurrently and produce duplicate responses.
    let resolveMonitorDone!: () => void;
    const monitorDone = new Promise<void>(resolve => { resolveMonitorDone = resolve; });

    try {
        // Reset PlanningDetector baseline BEFORE injecting the message.
        // This snapshots the current artifact count so the detector only
        // fires on NEW artifacts from the upcoming response (not old session artifacts).
        const projectName = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace;
        if (projectName) {
            const detector = bridge.pool.getPlanningDetector(projectName);
            if (detector) {
                await detector.resetBaseline().catch((err: Error) =>
                    logger.error('[sendPrompt] PlanningDetector baseline reset failed:', err),
                );
            }
        }

        let injectResult;
        if (inboundImages.length > 0) {
            injectResult = await cdp.injectMessageWithImageFiles(prompt, inboundImages.map(i => i.localPath));
            if (!injectResult.ok) {
                await sendEmbed(t('🖼️ Attached image fallback'), t('Failed to attach image directly, resending via URL reference.'));
                injectResult = await cdp.injectMessage(buildPromptWithAttachmentUrls(prompt, inboundImages));
            }
        } else {
            injectResult = await cdp.injectMessage(prompt);
        }

        if (!injectResult.ok) {
            isFinalized = true;
            await sendEmbed(`${PHASE_ICONS.error} Message Injection Failed`, `Failed to send message: ${injectResult.error}`);
            return;
        }

        const startTime = Date.now();
        const progressTitle = () => `${PHASE_ICONS.thinking} ${modelLabel}`;
        const progressFooter = () => `⏱️ ${Math.round((Date.now() - startTime) / 1000)}s`;

        let lastProgressTrigger = 0;
        let progressTriggerTimeout: NodeJS.Timeout | null = null;

        /** Trigger a progress message refresh */
        const triggerProgressRefresh = (): void => {
            const now = Date.now();
            if (now - lastProgressTrigger >= 3000) {
                if (progressTriggerTimeout) { clearTimeout(progressTriggerTimeout); progressTriggerTimeout = null; }
                lastProgressTrigger = now;
                liveActivityUpdateVersion += 1;
                const v = liveActivityUpdateVersion;
                refreshProgress(progressTitle(), progressFooter(), { expectedVersion: v, skipWhenFinalized: true }).catch(() => { });
            } else if (!progressTriggerTimeout) {
                progressTriggerTimeout = setTimeout(() => {
                    progressTriggerTimeout = null;
                    if (isFinalized) return;
                    lastProgressTrigger = Date.now();
                    liveActivityUpdateVersion += 1;
                    const v = liveActivityUpdateVersion;
                    refreshProgress(progressTitle(), progressFooter(), { expectedVersion: v, skipWhenFinalized: true }).catch(() => { });
                }, 3000 - (now - lastProgressTrigger));
            }
        };

        await refreshProgress(progressTitle(), progressFooter());

        monitor = new ResponseMonitor({
            cdpService: cdp,
            pollIntervalMs: 2000,
            maxDurationMs: 1800000,
            stopGoneConfirmCount: 5,
            onPhaseChange: () => { },
            onProcessLog: (logText) => {
                if (isFinalized) return;
                const trimmed = (logText || '').trim();
                if (!trimmed || isJunkEntry(trimmed)) return;
                const formatted = formatActivityLine(trimmed);
                if (formatted) {
                    progressLog.push({ kind: 'activity', text: formatted });
                    trimProgressLog();
                    triggerProgressRefresh();
                }
            },
            onThinkingLog: (thinkingText) => {
                if (isFinalized) return;
                const trimmed = (thinkingText || '').trim();
                if (!trimmed) return;
                logger.debug('[Bot] onThinkingLog received:', trimmed.slice(0, 100));

                const stripped = trimmed.replace(/^[^a-zA-Z]+/, '');

                if (/^thinking\.{0,3}$/i.test(stripped)) {
                    // Transient "Thinking..." — just set flag, don't add entry
                    thinkingActive = true;
                } else if (/^thought for\s/i.test(stripped)) {
                    // Completed thinking cycle: "Thought for 1s"
                    thinkingActive = false;
                    lastThoughtLabel = trimmed;
                    progressLog.push({ kind: 'thought', text: trimmed });
                    trimProgressLog();
                } else {
                    // Thinking content — merge as summary with most recent 'thought' entry
                    thinkingContentParts.push(trimmed);
                    const firstLine = trimmed.split('\n')[0].trim();
                    const heading = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
                    // Find most recent thought entry that doesn't yet have content attached
                    let merged = false;
                    for (let i = progressLog.length - 1; i >= 0; i--) {
                        if (progressLog[i].kind === 'thought') {
                            // Only merge if no content heading attached yet (no " — ")
                            if (!progressLog[i].text.includes(' — ')) {
                                progressLog[i].text += ` — ${heading}`;
                                merged = true;
                            }
                            break;
                        }
                    }
                    if (!merged && heading.length > 10) {
                        // No thought label to merge into — show as standalone content
                        progressLog.push({ kind: 'thought-content', text: heading });
                        trimProgressLog();
                    }
                }
                triggerProgressRefresh();
            },
            onProgress: (text) => {
                if (isFinalized) return;
                const isStructured = monitor?.getLastExtractionSource() === 'structured';
                const separated = isStructured ? { output: text, logs: '' } : splitOutputAndLogs(text);
                if (separated.output && separated.output.trim().length > 0) lastProgressText = separated.output;
            },
            onComplete: async (finalText, meta) => {
                if (isFinalized) return; // Guard: prevent duplicate completion
                isFinalized = true;
                if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                const wasStoppedByUser = userStopRequestedChannels.delete(channelKey(channel));
                if (wasStoppedByUser) {
                    logger.info(`[sendPrompt:${monitorTraceId}] Stopped by user`);
                    const keyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');
                    await sendMsg('⏹️ Generation stopped.', keyboard);
                    resolveMonitorDone?.();
                    return;
                }

                try {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const isQuotaError = monitor!.getPhase() === 'quotaReached' || monitor!.getQuotaDetected();

                    if (isQuotaError) {
                        liveActivityUpdateVersion += 1;
                        thinkingActive = false;
                        await setProgressMessage(`<b>⚠️ ${escapeHtml(modelLabel)} · Quota Reached</b>\n\n${buildProgressBody()}\n\n<i>⏱️ ${elapsed}s</i>`, { expectedVersion: liveActivityUpdateVersion });
                        liveResponseUpdateVersion += 1;
                        await upsertLiveResponse('⚠️ Quota Reached', 'Model quota limit reached. Please wait or switch to a different model.', `⏱️ ${elapsed}s`, { expectedVersion: liveResponseUpdateVersion });

                        try {
                            const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                            if (payload) {
                                await api.sendMessage(channel.chatId, payload.text, { parse_mode: 'HTML', message_thread_id: channel.threadId, reply_markup: payload.keyboard });
                            }
                        } catch (e) { logger.error('[Quota] Failed to send model selection UI:', e); }
                        resolveMonitorDone();
                        return;
                    }

                    // Fresh DOM re-extraction at completion time to ensure we get the
                    // complete response — polling may have captured partial/stale text.
                    let freshText = '';
                    let freshIsHtml = false;
                    try {
                        const contextId = cdp.getPrimaryContextId();
                        const evalParams: Record<string, unknown> = {
                            expression: extractAssistantSegmentsPayloadScript(),
                            returnByValue: true,
                            awaitPromise: true,
                        };
                        if (contextId !== null && contextId !== undefined) evalParams.contextId = contextId;
                        const freshResult = await cdp.call('Runtime.evaluate', evalParams);
                        const freshClassified = classifyAssistantSegments(freshResult?.result?.value);
                        if (freshClassified.diagnostics.source === 'dom-structured' && freshClassified.finalOutputText.trim()) {
                            freshText = freshClassified.finalOutputText.trim();
                            freshIsHtml = true;
                        }
                    } catch (e) { logger.debug('[onComplete] Fresh structured extraction failed:', e); }

                    // Pick the best text: fresh extraction > polled finalText > lastProgressText > emergency
                    const polledText = (finalText && finalText.trim().length > 0) ? finalText : lastProgressText;
                    const bestPolled = polledText && polledText.trim().length > 0 ? polledText : '';
                    // Prefer the fresh extraction if it's at least as long (more complete)
                    let finalResponseText: string;
                    let isAlreadyHtml: boolean;
                    if (freshText && freshText.length >= bestPolled.length) {
                        finalResponseText = freshText;
                        isAlreadyHtml = freshIsHtml;
                    } else if (bestPolled) {
                        finalResponseText = bestPolled;
                        isAlreadyHtml = meta?.source === 'structured';
                    } else {
                        const emergencyText = await tryEmergencyExtractText();
                        finalResponseText = emergencyText;
                        isAlreadyHtml = false;
                    }
                    const separated = isAlreadyHtml ? { output: finalResponseText, logs: '' } : splitOutputAndLogs(finalResponseText);
                    const finalOutputText = separated.output || finalResponseText;

                    // Send collapsible thinking block as a separate message before the response.
                    // Extract both label and content directly from DOM at completion time,
                    // so we don't depend on polling (2s interval) having captured thinking events.
                    try {
                        const thinkExtract = await cdp.call('Runtime.evaluate', {
                            expression: `(function() {
                                var panel = document.querySelector('.antigravity-agent-side-panel');
                                var scope = panel || document;
                                var details = scope.querySelectorAll('details');
                                var blocks = [];
                                for (var i = 0; i < details.length; i++) {
                                    var d = details[i];
                                    var summary = d.querySelector('summary');
                                    if (!summary) continue;
                                    var rawLabel = (summary.textContent || '').trim();
                                    var stripped = rawLabel.replace(/^[^a-zA-Z]+/, '');
                                    if (!/^(?:thought for|thinking)\\b/i.test(stripped)) continue;
                                    var wasOpen = d.open;
                                    if (!wasOpen) d.open = true;
                                    // Try children first, then fall back to full textContent minus summary
                                    var children = d.children;
                                    var parts = [];
                                    for (var c = 0; c < children.length; c++) {
                                        if (children[c].tagName === 'SUMMARY' || children[c].tagName === 'STYLE') continue;
                                        var t = (children[c].innerText || children[c].textContent || '').trim();
                                        if (t && t.length >= 5) parts.push(t);
                                    }
                                    // Fallback: use detail's full text minus the summary text
                                    if (parts.length === 0) {
                                        var fullText = (d.innerText || d.textContent || '').trim();
                                        var bodyText = fullText.replace(rawLabel, '').trim();
                                        if (bodyText && bodyText.length >= 5) parts.push(bodyText);
                                    }
                                    if (!wasOpen) d.open = false;
                                    blocks.push({ label: rawLabel, body: parts.join('\\n\\n') });
                                }
                                return blocks;
                            })()`,
                            returnByValue: true,
                        });
                        const thinkBlocks: Array<{ label: string; body: string }> = Array.isArray(thinkExtract?.result?.value) ? thinkExtract.result.value : [];
                        if (thinkBlocks.length > 0) {
                            // Also incorporate poll-accumulated content if available
                            const accumulatedBody = thinkingContentParts.join('\n\n');
                            // Build combined thinking message — merge all blocks
                            const sections: string[] = [];
                            for (const block of thinkBlocks) {
                                const label = block.label || lastThoughtLabel || 'Thinking';
                                const body = block.body || accumulatedBody || '';
                                if (body) {
                                    sections.push(`  💭 <b>${escapeHtml(label)}</b>\n\n<i>${escapeHtml(body)}</i>`);
                                } else {
                                    sections.push(`  💭 <b>${escapeHtml(label)}</b>`);
                                }
                            }
                            const combined = sections.join('\n\n');
                            const maxThinkLen = TELEGRAM_MSG_LIMIT - 100;
                            const trimmed = combined.length > maxThinkLen ? combined.slice(0, maxThinkLen) + '...' : combined;
                            const thinkMsg = `<blockquote expandable>${trimmed}</blockquote>`;
                            logger.info(`[Bot] Sending thinking block: ${thinkBlocks.length} block(s), ${combined.length} chars`);
                            await sendMsg(thinkMsg);
                        } else {
                            logger.info('[Bot] No thinking blocks found in DOM at completion time');
                        }
                    } catch (e) { logger.error('[Bot] Failed to send thinking block:', e); }

                    if (finalOutputText && finalOutputText.trim().length > 0) {
                        logger.divider(`Output (${finalOutputText.length} chars)`);
                        console.info(finalOutputText);
                    }
                    logger.divider();

                    // Compact progress message: show completed title + event log
                    liveActivityUpdateVersion += 1;
                    thinkingActive = false;
                    const completedBody = buildProgressBody();
                    await setProgressMessage(`<b>${PHASE_ICONS.complete} ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${completedBody}`, { expectedVersion: liveActivityUpdateVersion });

                    const replyKeyboard = new InlineKeyboard();
                    if (meta?.choices && meta.choices.length > 0) {
                        const projectName = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace || 'default';
                        lastChoicesCache.set(channelKey(channel), meta.choices);
                        meta.choices.forEach((choice, idx) => {
                            replyKeyboard.text(choice, `ai_choice:${projectName}:${idx}`);
                            replyKeyboard.row();
                        });
                    }
                    replyKeyboard.text('↩️ ' + t('Undo'), 'undo_last');

                    liveResponseUpdateVersion += 1;
                    if (finalOutputText && finalOutputText.trim().length > 0) {
                        const footer = `⏱️ ${elapsed}s`;
                        await sendChunkedResponse('', footer, finalOutputText, isAlreadyHtml, replyKeyboard);
                    } else {
                        await upsertLiveResponse(`${PHASE_ICONS.complete} Complete`, t('Failed to extract response. Use /screenshot to verify.'), `⏱️ ${elapsed}s`, { expectedVersion: liveResponseUpdateVersion, replyMarkup: replyKeyboard });
                    }

                    if (options) {
                        try {
                            const sessionInfo = await options.chatSessionService.getCurrentSessionInfo(cdp);
                            if (sessionInfo && sessionInfo.hasActiveChat && sessionInfo.title && sessionInfo.title !== t('(Untitled)')) {
                                const session = options.chatSessionRepo.findByChannelId(channelKey(channel));
                                const projectName = session
                                    ? bridge.pool.extractProjectName(session.workspacePath)
                                    : cdp.getCurrentWorkspaceName();
                                if (projectName) {
                                    registerApprovalSessionChannel(bridge, projectName, sessionInfo.title, channel);
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

                    await sendGeneratedImages(finalOutputText || '');
                } catch (error) { logger.error(`[sendPrompt:${monitorTraceId}] onComplete failed:`, error); } finally { resolveMonitorDone?.(); }
            },
            onTimeout: async (lastText: string) => {
                try {
                    isFinalized = true;
                    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                    userStopRequestedChannels.delete(channelKey(channel));
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const timeoutText = (lastText && lastText.trim().length > 0) ? lastText : lastProgressText;
                    const timeoutIsHtml = monitor!.getLastExtractionSource() === 'structured';
                    const separated = timeoutIsHtml ? { output: timeoutText || '', logs: '' } : splitOutputAndLogs(timeoutText || '');
                    const payload = separated.output && separated.output.trim().length > 0
                        ? `${separated.output}\n\n[Monitor Ended] Timeout after 30 minutes.`
                        : 'Monitor ended after 30 minutes. No text was retrieved.';

                    const undoKeyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');

                    liveResponseUpdateVersion += 1;
                    await sendChunkedResponse(`${PHASE_ICONS.timeout} Timeout`, `⏱️ ${elapsed}s`, payload, timeoutIsHtml, undoKeyboard);
                    liveActivityUpdateVersion += 1;
                    thinkingActive = false;
                    await setProgressMessage(`<b>${PHASE_ICONS.timeout} ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${buildProgressBody()}`, { expectedVersion: liveActivityUpdateVersion });
                } catch (error) { logger.error(`[sendPrompt:${monitorTraceId}] onTimeout failed:`, error); } finally { resolveMonitorDone?.(); }
            },
        });

        await monitor.start();

        elapsedTimer = setInterval(() => {
            if (isFinalized) { clearInterval(elapsedTimer!); return; }
            triggerProgressRefresh();
        }, 5000);

        // Hold the PromptDispatcher lock until the monitor fires onComplete or onTimeout.
        // This prevents a second incoming prompt from injecting while Antigravity is still generating.
        await monitorDone;

    } catch (e: any) {
        isFinalized = true;
        userStopRequestedChannels.delete(channelKey(channel));
        if (elapsedTimer) { clearInterval(elapsedTimer); }
        if (monitor) { await monitor.stop().catch(() => {}); }
        resolveMonitorDone();
        await sendEmbed(`${PHASE_ICONS.error} Error`, t(`Error occurred during processing: ${e.message}`));
    }
}

async function mirrorResponseToTelegram(
    bridge: CdpBridge,
    channel: TelegramChannel,
    cdp: CdpService,
    userPrompt: string,
    options: {
        chatSessionService: ChatSessionService;
        chatSessionRepo: ChatSessionRepository;
        topicManager: TelegramTopicManager;
        titleGenerator: TitleGeneratorService;
        modelService: ModelService;
        workspaceBindingRepo: WorkspaceBindingRepository;
    }
): Promise<void> {
    logger.info(`[mirror] Starting response mirror for channel ${channel.chatId} (prompt: "${userPrompt.slice(0, 30)}...")`);
    const api = bridge.botApi!;
    const monitorTraceId = channelKey(channel);
    const enqueueGeneral = createSerialTaskQueue('general', monitorTraceId);
    const enqueueResponse = createSerialTaskQueue('response', monitorTraceId);
    const enqueueActivity = createSerialTaskQueue('activity', monitorTraceId);

    const workspaceName = cdp.getCurrentWorkspaceName();

    const shouldSkipMirroring = (): boolean => {
        const conf = loadConfig();
        if (!conf.onlyActiveWorkspaceMessages) return false;
        const binding = options.workspaceBindingRepo.findByChannelId(channelKey(channel));
        if (!binding) return true;
        const activeProjectName = bridge.pool.extractProjectName(binding.workspacePath);
        const currentProjectName = workspaceName ? bridge.pool.extractProjectName(workspaceName) : '';
        return activeProjectName !== currentProjectName;
    };

    const sendMsg = async (text: string, replyMarkup?: any): Promise<number | null> => {
        if (shouldSkipMirroring()) return null;
        try {
            const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
            logger.info(`[mirror] Sending message to Telegram (${text.slice(0, 40)}...)`);
            const msg = await api.sendMessage(channel.chatId, truncated, {
                parse_mode: 'HTML',
                message_thread_id: channel.threadId,
                reply_markup: replyMarkup,
            });
            logger.info(`[mirror] Message sent successfully (ID: ${msg.message_id})`);
            return msg.message_id;
        } catch (e) {
            logger.error('[mirror:sendMsg] Failed:', e);
            return null;
        }
    };

    const editMsg = async (msgId: number, text: string, replyMarkup?: any, maxRetries = 3): Promise<void> => {
        if (shouldSkipMirroring()) return;
        const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
        logger.info(`[mirror] Editing message ${msgId} (${text.slice(0, 40)}...)`);
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await api.editMessageText(channel.chatId, msgId, truncated, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                });
                logger.info(`[mirror] Message ${msgId} edited successfully`);
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

    const sendEmbed = (title: string, description: string): Promise<void> => enqueueGeneral(async () => {
        if (shouldSkipMirroring()) return;
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
            } catch (e) { logger.error('[mirror] Failed to send response file:', e); }
        }
    };

    if (!cdp.isConnected()) {
        await sendEmbed(
            `${PHASE_ICONS.error} Connection Error`,
            `Not connected to Antigravity.`,
        );
        return;
    }

    const currentModel = (await cdp.getCurrentModel()) || options.modelService.getCurrentModel();
    const modelLabel = `${currentModel}`;
    const stopKeyboard = new InlineKeyboard().text('⏹️ Stop', 'stop_generation');

    const cleanProjName = workspaceName ? workspaceName.replace(/\.code-workspace$/i, '') : '';
    const ideLabel = cleanProjName ? `IDE: ${cleanProjName}` : 'IDE';

    let liveActivityMsgId: number | null = null;
    try {
        const generatingText = `<b>${PHASE_ICONS.thinking} [${ideLabel}] · ${escapeHtml(modelLabel)}</b>\n\n<i>Generating...</i>`;
        logger.info(`[mirror] Sending initial status to Telegram...`);
        const generatingMsg = await api.sendMessage(channel.chatId, generatingText, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: stopKeyboard,
        });
        liveActivityMsgId = generatingMsg.message_id;
        logger.info(`[mirror] Initial status message sent (ID: ${liveActivityMsgId})`);
    } catch (e) { logger.error('[mirror] Failed to send initial status:', e); }

    let isFinalized = false;
    let elapsedTimer: ReturnType<typeof setInterval> | null = null;
    let lastProgressText = '';
    const LIVE_RESPONSE_MAX_LEN = 3800;
    const MAX_PROGRESS_BODY = 3500;
    const MAX_PROGRESS_ENTRIES = 60;
    let liveResponseMsgId: number | null = null;
    let lastLiveResponseKey = '';
    let lastLiveActivityKey = '';
    let liveResponseUpdateVersion = 0;
    let liveActivityUpdateVersion = 0;

    interface ProgressEntry { kind: 'thought' | 'thought-content' | 'activity'; text: string; }
    const progressLog: ProgressEntry[] = [];
    let thinkingActive = false;
    const thinkingContentParts: string[] = [];
    let lastThoughtLabel = '';

    const isJunkEntry = (text: string): boolean => {
        const t = text.trim();
        if (t.length < 5) return true;
        if (/^\d+$/.test(t)) return true;
        if (!/\s/.test(t) && t.length < 8) return true;
        return false;
    };

    const formatActivityLine = (raw: string): string => {
        const collapsed = (raw || '').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (!collapsed || isJunkEntry(collapsed)) return '';
        return escapeHtml(collapsed.slice(0, 120));
    };

    const trimProgressLog = (): void => {
        while (progressLog.length > MAX_PROGRESS_ENTRIES) progressLog.shift();
    };

    const buildProgressBody = (): string => {
        const lines: string[] = [];
        for (const e of progressLog) {
            switch (e.kind) {
                case 'thought':
                    lines.push(`💭 <i>${escapeHtml(e.text)}</i>`);
                    break;
                case 'thought-content':
                    lines.push(`<i>${escapeHtml(e.text)}</i>`);
                    break;
                case 'activity':
                    lines.push(e.text);
                    break;
            }
        }
        if (thinkingActive) {
            lines.push('💭 <i>Thinking...</i>');
        }
        let body = lines.join('\n\n');
        if (body.length > MAX_PROGRESS_BODY) {
            body = '...\n\n' + body.slice(-MAX_PROGRESS_BODY + 5);
        }
        return body || '<i>Generating...</i>';
    };

    const buildProgressMessage = (title: string, footer: string): string => {
        const body = buildProgressBody();
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        return `<b>${escapeHtml(title)}</b>\n\n${body}${footerLine}`;
    };

    const buildLiveResponseText = (title: string, rawText: string, footer: string, isAlreadyHtml = false, skipTruncation = false): string => {
        const normalized = (rawText || '').trim();
        const body = normalized
            ? (isAlreadyHtml ? normalized : formatForTelegram(normalized))
            : t('Generating...');
        const truncated = (!skipTruncation && body.length > LIVE_RESPONSE_MAX_LEN)
            ? '...(beginning truncated)\n' + body.slice(-LIVE_RESPONSE_MAX_LEN + 30)
            : body;
        const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        return `${titleLine}${truncated}${footerLine}`;
    };

    const upsertLiveResponse = (title: string, rawText: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean; isAlreadyHtml?: boolean; skipTruncation?: boolean; replyMarkup?: any }): Promise<void> =>
        enqueueResponse(async () => {
            if (shouldSkipMirroring()) return;
            if (opts?.skipWhenFinalized && isFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveResponseUpdateVersion) return;
            const text = buildLiveResponseText(title, rawText, footer, opts?.isAlreadyHtml, opts?.skipTruncation);
            const renderKey = `${title}|${rawText.slice(0, 200)}|${footer}|${opts?.replyMarkup ? 'with-markup' : 'no-markup'}`;
            if (renderKey === lastLiveResponseKey && liveResponseMsgId) return;
            lastLiveResponseKey = renderKey;

            if (liveResponseMsgId) {
                await editMsg(liveResponseMsgId, text, opts?.replyMarkup);
            } else {
                liveResponseMsgId = await sendMsg(text, opts?.replyMarkup);
            }
        }, 'upsert-response');

    const refreshProgress = (title: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean }): Promise<void> =>
        enqueueActivity(async () => {
            if (shouldSkipMirroring()) return;
            if (opts?.skipWhenFinalized && isFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
            const text = buildProgressMessage(title, footer);
            const bodySnap = progressLog.length + '|' + thinkingActive + '|' + title + '|' + footer;
            if (bodySnap === lastLiveActivityKey && liveActivityMsgId) return;
            lastLiveActivityKey = bodySnap;

            const keyboard = isFinalized ? undefined : stopKeyboard;
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, text, keyboard);
            } else {
                liveActivityMsgId = await sendMsg(text, keyboard);
            }
        }, 'upsert-activity');

    const setProgressMessage = (htmlContent: string, opts?: { expectedVersion?: number }): Promise<void> =>
        enqueueActivity(async () => {
            if (shouldSkipMirroring()) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
            lastLiveActivityKey = htmlContent.slice(0, 200);
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, htmlContent, undefined);
            } else {
                liveActivityMsgId = await sendMsg(htmlContent, undefined);
            }
        }, 'upsert-activity');

    const sendGeneratedImages = async (responseText: string): Promise<void> => {
        if (shouldSkipMirroring()) return;
        const imageIntentPattern = /(image|images|png|jpg|jpeg|gif|webp|illustration|diagram|render)/i;
        const imageUrlPattern = /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp)/i;
        if (!imageIntentPattern.test(userPrompt) && !responseText.includes('![') && !imageUrlPattern.test(responseText)) return;

        const extracted = await cdp.extractLatestResponseImages(MAX_OUTBOUND_GENERATED_IMAGES);
        if (extracted.length === 0) return;

        for (let i = 0; i < extracted.length; i++) {
            const file = await toTelegramInputFile(extracted[i], i);
            if (file) {
                try {
                    await api.sendPhoto(channel.chatId, new InputFile(file.buffer, file.name), {
                        caption: `🖼️ Generated image (${i + 1}/${extracted.length})`,
                        message_thread_id: channel.threadId,
                    });
                } catch (e) { logger.error('[mirror:sendImages] Failed:', e); }
            }
        }
    };

    const tryEmergencyExtractText = async (): Promise<string> => {
        try {
            const contextId = cdp.getPrimaryContextId();
            const expression = `(() => {
                const panel = document.querySelector('.antigravity-agent-side-panel');
                const rootScope = panel || document;
                const userMessages = rootScope.querySelectorAll('[role="article"][aria-label="User message"], [aria-label="User message"], [data-testid="user-input-step"]');
                const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
                let assistantTurns = Array.from(rootScope.querySelectorAll('[data-message-author-role="assistant"], [role="article"][aria-label="Agent response"], [aria-label="Agent response"]'));
                let scope = null;
                if (lastUserMsg) {
                    assistantTurns = assistantTurns.filter(node => !!(lastUserMsg.compareDocumentPosition(node) & 4));
                    scope = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
                } else {
                    scope = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : rootScope;
                }
                if (!scope) return '';

                const candidateSelectors = ['.rendered-markdown', '.leading-relaxed.select-text', '.flex.flex-col.gap-y-3', '[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[class*="assistant-message"]', '[class*="message-content"]', '[class*="markdown-body"]', '.prose'];
                const looksLikeActivity = (text) => { const n = (text || '').trim().toLowerCase(); if (!n) return true; return /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|analyzed|read|wrote|ran)/i.test(n) && n.length <= 220; };
                const clean = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
                const candidates = []; const seen = new Set();
                for (const selector of candidateSelectors) { const nodes = scope.querySelectorAll(selector); for (const node of nodes) { if (!node || seen.has(node)) continue; seen.add(node); candidates.push(node); } }
                for (let i = candidates.length - 1; i >= 0; i--) { const node = candidates[i]; const text = clean(node.innerText || node.textContent || ''); if (!text || text.length < 20) continue; if (looksLikeActivity(text)) continue; if (/^(good|bad)$/i.test(text)) continue; return text; }
                return '';
            })()`;
            const callParams: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
            if (contextId !== null) callParams.contextId = contextId;
            const res = await cdp.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            return typeof value === 'string' ? value.trim() : '';
        } catch (e) { logger.debug('[mirror:emergency] Failed:', e); return ''; }
    };

    let monitor: ResponseMonitor | null = null;
    let resolveMonitorDone!: () => void;
    const monitorDone = new Promise<void>(resolve => { resolveMonitorDone = resolve; });

    try {
        const startTime = Date.now();
        const progressTitle = () => `🧠 [${ideLabel}] · ${modelLabel}`;
        const progressFooter = () => `⏱️ ${Math.round((Date.now() - startTime) / 1000)}s`;

        let lastProgressTrigger = 0;
        let progressTriggerTimeout: NodeJS.Timeout | null = null;

        const triggerProgressRefresh = (): void => {
            const now = Date.now();
            if (now - lastProgressTrigger >= 3000) {
                if (progressTriggerTimeout) { clearTimeout(progressTriggerTimeout); progressTriggerTimeout = null; }
                lastProgressTrigger = now;
                liveActivityUpdateVersion += 1;
                const v = liveActivityUpdateVersion;
                refreshProgress(progressTitle(), progressFooter(), { expectedVersion: v, skipWhenFinalized: true }).catch(() => { });
            } else if (!progressTriggerTimeout) {
                progressTriggerTimeout = setTimeout(() => {
                    progressTriggerTimeout = null;
                    if (isFinalized) return;
                    lastProgressTrigger = Date.now();
                    liveActivityUpdateVersion += 1;
                    const v = liveActivityUpdateVersion;
                    refreshProgress(progressTitle(), progressFooter(), { expectedVersion: v, skipWhenFinalized: true }).catch(() => { });
                }, 3000 - (now - lastProgressTrigger));
            }
        };

        elapsedTimer = setInterval(() => {
            if (isFinalized) return;
            triggerProgressRefresh();
        }, 1000);

        monitor = new ResponseMonitor({
            cdpService: cdp,
            pollIntervalMs: 2000,
            maxDurationMs: 1800000,
            stopGoneConfirmCount: 5,
            onPhaseChange: () => { },
            onProcessLog: (logText) => {
                if (isFinalized) return;
                const trimmed = (logText || '').trim();
                if (!trimmed || isJunkEntry(trimmed)) return;
                const formatted = formatActivityLine(trimmed);
                if (formatted) {
                    progressLog.push({ kind: 'activity', text: formatted });
                    trimProgressLog();
                    triggerProgressRefresh();
                }
            },
            onThinkingLog: (thinkingText) => {
                if (isFinalized) return;
                const trimmed = (thinkingText || '').trim();
                if (!trimmed) return;
                logger.debug('[mirror] onThinkingLog received:', trimmed.slice(0, 100));

                const stripped = trimmed.replace(/^[^a-zA-Z]+/, '');
                if (/^thinking\.{0,3}$/i.test(stripped)) {
                    thinkingActive = true;
                } else if (/^thought for\s/i.test(stripped)) {
                    thinkingActive = false;
                    lastThoughtLabel = trimmed;
                    progressLog.push({ kind: 'thought', text: trimmed });
                    trimProgressLog();
                } else {
                    thinkingContentParts.push(trimmed);
                    const firstLine = trimmed.split('\n')[0].trim();
                    const heading = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
                    let merged = false;
                    for (let i = progressLog.length - 1; i >= 0; i--) {
                        if (progressLog[i].kind === 'thought') {
                            if (!progressLog[i].text.includes(' — ')) {
                                progressLog[i].text += ` — ${heading}`;
                                merged = true;
                            }
                            break;
                        }
                    }
                    if (!merged && heading.length > 10) {
                        progressLog.push({ kind: 'thought-content', text: heading });
                        trimProgressLog();
                    }
                }
                triggerProgressRefresh();
            },
            onProgress: (text) => {
                if (isFinalized) return;
                const isStructured = monitor?.getLastExtractionSource() === 'structured';
                const separated = isStructured ? { output: text, logs: '' } : splitOutputAndLogs(text);
                if (separated.output && separated.output.trim().length > 0) {
                    lastProgressText = separated.output;
                    liveResponseUpdateVersion += 1;
                    upsertLiveResponse('', lastProgressText, '', { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml: isStructured, skipWhenFinalized: true }).catch(() => {});
                }
            },
            onComplete: async (finalText, meta) => {
                logger.info(`[mirror] ResponseMonitor fired onComplete (text len: ${finalText.length})`);
                if (isFinalized) return;
                isFinalized = true;
                if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                const wasStoppedByUser = userStopRequestedChannels.delete(channelKey(channel));
                if (wasStoppedByUser) {
                    logger.info(`[mirror:${monitorTraceId}] Stopped by user`);
                    const keyboard = new InlineKeyboard().text('↩️ ' + t('Undo'), 'undo_last');
                    await sendMsg('⏹️ Generation stopped.', keyboard);
                    resolveMonitorDone?.();
                    return;
                }

                try {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const isQuotaError = monitor!.getPhase() === 'quotaReached' || monitor!.getQuotaDetected();

                    if (isQuotaError) {
                        liveActivityUpdateVersion += 1;
                        thinkingActive = false;
                        await setProgressMessage(`<b>⚠️ [${ideLabel}] · Quota Reached</b>\n\n${buildProgressBody()}\n\n<i>⏱️ ${elapsed}s</i>`, { expectedVersion: liveActivityUpdateVersion });
                        liveResponseUpdateVersion += 1;
                        await upsertLiveResponse('⚠️ Quota Reached', 'Model quota limit reached. Please wait or switch to a different model.', `⏱️ ${elapsed}s`, { expectedVersion: liveResponseUpdateVersion });
                        resolveMonitorDone();
                        return;
                    }

                    let freshText = '';
                    let freshIsHtml = false;
                    try {
                        const contextId = cdp.getPrimaryContextId();
                        const evalParams: Record<string, unknown> = {
                            expression: extractAssistantSegmentsPayloadScript(),
                            returnByValue: true,
                            awaitPromise: true,
                        };
                        if (contextId !== null && contextId !== undefined) evalParams.contextId = contextId;
                        const freshResult = await cdp.call('Runtime.evaluate', evalParams);
                        const freshClassified = classifyAssistantSegments(freshResult?.result?.value);
                        if (freshClassified.diagnostics.source === 'dom-structured' && freshClassified.finalOutputText.trim()) {
                            freshText = freshClassified.finalOutputText.trim();
                            freshIsHtml = true;
                        }
                    } catch (e) { logger.debug('[mirror:onComplete] Fresh structured extraction failed:', e); }

                    const polledText = (finalText && finalText.trim().length > 0) ? finalText : lastProgressText;
                    const bestPolled = polledText && polledText.trim().length > 0 ? polledText : '';
                    let finalResponseText: string;
                    let isAlreadyHtml: boolean;
                    if (freshText && freshText.length >= bestPolled.length) {
                        finalResponseText = freshText;
                        isAlreadyHtml = freshIsHtml;
                    } else if (bestPolled) {
                        finalResponseText = bestPolled;
                        isAlreadyHtml = meta?.source === 'structured';
                    } else {
                        finalResponseText = await tryEmergencyExtractText();
                        isAlreadyHtml = false;
                    }
                    const separated = isAlreadyHtml ? { output: finalResponseText, logs: '' } : splitOutputAndLogs(finalResponseText);
                    const finalOutputText = separated.output || finalResponseText;

                    try {
                        const thinkExtract = await cdp.call('Runtime.evaluate', {
                            expression: `(function() {
                                var panel = document.querySelector('.antigravity-agent-side-panel');
                                var scope = panel || document;
                                var details = scope.querySelectorAll('details');
                                var blocks = [];
                                for (var i = 0; i < details.length; i++) {
                                    var d = details[i];
                                    var summary = d.querySelector('summary');
                                    if (!summary) continue;
                                    var rawLabel = (summary.textContent || '').trim();
                                    var stripped = rawLabel.replace(/^[^a-zA-Z]+/, '');
                                    if (!/^(?:thought for|thinking)\\b/i.test(stripped)) continue;
                                    var wasOpen = d.open;
                                    if (!wasOpen) d.open = true;
                                    var children = d.children;
                                    var parts = [];
                                    for (var c = 0; c < children.length; c++) {
                                        if (children[c].tagName === 'SUMMARY' || children[c].tagName === 'STYLE') continue;
                                        var t = (children[c].innerText || children[c].textContent || '').trim();
                                        if (t && t.length >= 5) parts.push(t);
                                    }
                                    if (parts.length === 0) {
                                        var fullText = (d.innerText || d.textContent || '').trim();
                                        var bodyText = fullText.replace(rawLabel, '').trim();
                                        if (bodyText && bodyText.length >= 5) parts.push(bodyText);
                                    }
                                    if (!wasOpen) d.open = false;
                                    blocks.push({ label: rawLabel, body: parts.join('\\n\\n') });
                                }
                                return blocks;
                            })()`,
                            returnByValue: true,
                        });
                        const thinkBlocks: Array<{ label: string; body: string }> = Array.isArray(thinkExtract?.result?.value) ? thinkExtract.result.value : [];
                        if (thinkBlocks.length > 0) {
                            const accumulatedBody = thinkingContentParts.join('\n\n');
                            const sections: string[] = [];
                            for (const block of thinkBlocks) {
                                const label = block.label || lastThoughtLabel || 'Thinking';
                                const body = block.body || accumulatedBody || '';
                                if (body) {
                                    sections.push(`  💭 <b>${escapeHtml(label)}</b>\n\n<i>${escapeHtml(body)}</i>`);
                                } else {
                                    sections.push(`  💭 <b>${escapeHtml(label)}</b>`);
                                }
                            }
                            const combined = sections.join('\n\n');
                            const maxThinkLen = TELEGRAM_MSG_LIMIT - 100;
                            const trimmed = combined.length > maxThinkLen ? combined.slice(0, maxThinkLen) + '...' : combined;
                            const thinkMsg = `<blockquote expandable>${trimmed}</blockquote>`;
                            await sendMsg(thinkMsg);
                        }
                    } catch (e) { logger.error('[mirror] Failed to send thinking block:', e); }

                    liveActivityUpdateVersion += 1;
                    thinkingActive = false;
                    const completedBody = buildProgressBody();
                    await setProgressMessage(`<b>🧠 [${ideLabel}] · ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${completedBody}`, { expectedVersion: liveActivityUpdateVersion });

                    const replyKeyboard = new InlineKeyboard();
                    if (meta?.choices && meta.choices.length > 0) {
                        const projectName = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace || 'default';
                        lastChoicesCache.set(channelKey(channel), meta.choices);
                        meta.choices.forEach((choice, idx) => {
                            replyKeyboard.text(choice, `ai_choice:${projectName}:${idx}`);
                            replyKeyboard.row();
                        });
                    }
                    replyKeyboard.text('↩️ ' + t('Undo'), 'undo_last');

                    liveResponseUpdateVersion += 1;
                    if (finalOutputText && finalOutputText.trim().length > 0) {
                        const footer = `⏱️ ${elapsed}s`;
                        await sendChunkedResponse('', footer, finalOutputText, isAlreadyHtml, replyKeyboard);
                    } else {
                        await upsertLiveResponse(`${PHASE_ICONS.complete} Complete`, t('Failed to extract response. Use /screenshot to verify.'), `⏱️ ${elapsed}s`, { expectedVersion: liveResponseUpdateVersion, replyMarkup: replyKeyboard });
                    }
                    logger.info(`[mirror] Response successfully mirrored to Telegram`);

                    try {
                        const sessionInfo = await options.chatSessionService.getCurrentSessionInfo(cdp);
                        if (sessionInfo && sessionInfo.hasActiveChat && sessionInfo.title && sessionInfo.title !== t('(Untitled)')) {
                            const session = options.chatSessionRepo.findByChannelId(channelKey(channel));
                            const projName = session
                                ? bridge.pool.extractProjectName(session.workspacePath)
                                : cdp.getCurrentWorkspaceName();
                            if (projName) {
                                registerApprovalSessionChannel(bridge, projName, sessionInfo.title, channel);
                            }

                            if (session && session.displayName !== sessionInfo.title) {
                                const newName = options.titleGenerator.sanitizeForChannelName(sessionInfo.title);
                                const formattedName = `${session.sessionNumber}-${newName}`;
                                const threadId = session.channelId.includes(':')
                                    ? Number(session.channelId.split(':')[1])
                                    : undefined;
                                if (threadId) {
                                    options.topicManager.setChatId(Number(session.channelId.split(':')[0]));
                                    await options.topicManager.renameTopic(threadId, formattedName);
                                    options.chatSessionRepo.updateDisplayName(channelKey(channel), sessionInfo.title);
                                    logger.info(`[mirror] Sync: Thread renamed to ${formattedName}`);
                                }
                            }
                        }
                    } catch (e) { logger.error('[mirror] Failed to sync session title:', e); }

                    await sendGeneratedImages(finalOutputText);
                } catch (e: any) {
                    logger.error('[mirror:onComplete] Failed:', e);
                } finally {
                    resolveMonitorDone();
                    logger.info(`[mirror] monitorDone resolved`);
                }
            },
            onTimeout: async (lastText) => {
                logger.warn(`[mirror] ResponseMonitor fired onTimeout`);
                if (isFinalized) return;
                isFinalized = true;
                if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                liveActivityUpdateVersion += 1;
                await setProgressMessage(`<b>⏰ Timeout</b>\n\n<i>⏱️ ${elapsed}s</i>`, { expectedVersion: liveActivityUpdateVersion });
                resolveMonitorDone();
                logger.info(`[mirror] monitorDone resolved (timeout)`);
            },
        });

        logger.info(`[mirror] Starting passive monitoring...`);
        await monitor.startPassive();
    } catch (e: any) {
        logger.error(`[mirror] Error in mirrorResponseToTelegram:`, e);
        isFinalized = true;
        if (elapsedTimer) { clearInterval(elapsedTimer); }
        if (monitor) { await monitor.stop().catch(() => {}); }
        resolveMonitorDone();
        await sendEmbed(`${PHASE_ICONS.error} Error`, t(`Error occurred during processing: ${e.message}`));
    }

    return monitorDone;
}

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
                if (pending.interruptMsgId && bridge.botApi) {
                    bridge.botApi.editMessageText(
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
    bridge.botApi = bot.api;

    // Notify user on WebSocket connection lifecycle events
    bridge.pool.on('workspace:disconnected', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel || !bridge.botApi) return;
        bridge.botApi.sendMessage(channel.chatId, `⚠️ <b>${escapeHtml(projectName)}</b>: Connection lost. Reconnecting…`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err) => logger.error('[Bot] Failed to send disconnect notification:', err));
    });

    bridge.pool.on('workspace:reconnected', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel || !bridge.botApi) return;
        bridge.botApi.sendMessage(channel.chatId, `✅ <b>${escapeHtml(projectName)}</b>: Reconnected.`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err) => logger.error('[Bot] Failed to send reconnect notification:', err));
    });

    bridge.pool.on('workspace:reconnectFailed', async (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel || !bridge.botApi) return;

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

        bridge.botApi.sendMessage(channel.chatId, text, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: keyboard,
        }).catch((err) => logger.error('[Bot] Failed to send reconnect-failed notification:', err));
    });

    const topicManager = new TelegramTopicManager(bot.api, 0);

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

    // Helper to build TelegramChannel from context
    const getChannel = (ctx: Context): TelegramChannel => ({
        chatId: ctx.chat!.id,
        threadId: ctx.message?.message_thread_id ?? undefined,
    });

    const getChannelFromCb = (ctx: Context): TelegramChannel => ({
        chatId: ctx.chat!.id,
        threadId: ctx.callbackQuery?.message?.message_thread_id ?? undefined,
    });

    const setupWorkspaceDetectors = (cdp: any, projectName: string, channel: TelegramChannel) => {
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
                workspaceBindingRepo
            });

            promptDispatcher.acquireLock(channel, cdp, mirrorPromise);
            return true;
        };
        ensureUserMessageDetector(bridge, cdp, projectName, onUserMessageCallback);
    };

    const resolveWorkspaceAndCdp = (ch: TelegramChannel): Promise<ResolveOutcome> =>
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

    // Helper to query workspace path directly from a running IDE window via CDP
    const queryWorkspacePath = async (wsUrl: string): Promise<{ workspacePath: string | null; workspaceId: string | null } | null> => {
        return new Promise((resolve) => {
            const ws = new WebSocket(wsUrl);
            let resolved = false;
            
            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
                try { ws.close(); } catch {}
            };

            const timeout = setTimeout(cleanup, 2000);

            ws.on('open', () => {
                if (resolved) return;
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: `(async () => {
                            if (window.vscode && window.vscode.context) {
                                const config = await window.vscode.context.resolveConfiguration();
                                return {
                                    workspacePath: config.workspace?.configPath?._fsPath || config.workspace?.uri?._fsPath || null,
                                    workspaceId: config.workspace?.id || null
                                };
                            }
                            return null;
                        })()`,
                        returnByValue: true,
                        awaitPromise: true
                    }
                }));
            });

            ws.on('message', (data) => {
                if (resolved) return;
                clearTimeout(timeout);
                resolved = true;
                try {
                    const parsed = JSON.parse(data.toString());
                    const val = parsed.result?.result?.value;
                    resolve(val || null);
                } catch {
                    resolve(null);
                }
                try { ws.close(); } catch {}
            });

            ws.on('error', cleanup);
        });
    };

    // Scan active IDE windows
    const scanActiveWindows = async () => {
        const recentWorkspaces = workspaceService.getRecentWorkspaces();
        const activeWindows: { port: number; title: string; workspacePath: string | null; projectName: string }[] = [];

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

                        // Reuse already connected cdp service path to avoid CDP evaluation lag/hangs
                        const existingPath = bridge.pool.getWorkspacePathByWebSocketUrl(page.webSocketDebuggerUrl);
                        let cdpInfo = null;
                        if (existingPath) {
                            cdpInfo = { workspacePath: existingPath, workspaceId: null };
                        } else {
                            cdpInfo = await queryWorkspacePath(page.webSocketDebuggerUrl);
                        }
                        if (cdpInfo && cdpInfo.workspacePath) {
                            if (cdpInfo.workspacePath.endsWith('workspace.json')) {
                                workspacePath = null;
                            } else {
                                workspacePath = cdpInfo.workspacePath;
                                const normPath = workspacePath.toLowerCase().replace(/\//g, '\\').trim();
                                matchedWorkspace = recentWorkspaces.find(w => {
                                    const normWPath = w.path.toLowerCase().replace(/\//g, '\\').trim();
                                    return normWPath === normPath;
                                }) || null;
                            }
                        }

                        let projectName = '';
                        if (matchedWorkspace) {
                            projectName = matchedWorkspace.name;
                        } else if (workspacePath) {
                            projectName = path.basename(workspacePath);
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
                            workspacePath = matchedWorkspace ? matchedWorkspace.path : null;
                        }

                        if (!workspacePath) {
                            workspacePath = `empty-workspace:${port}:${page.id}`;
                            const name = (projectName && projectName !== 'Unknown') ? projectName : 'Antigravity';
                            projectName = `${name} (без папки)`;
                        }

                        activeWindows.push({
                            port,
                            title,
                            workspacePath,
                            projectName: projectName.replace(/\.code-workspace$/i, '')
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
                    const targetChannel: TelegramChannel = {
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

        // Get bound workspace for CURRENT chat
        const ch = getChannel(ctx);
        const binding = workspaceBindingRepo.findByChannelId(channelKey(ch));
        if (binding) {
            const isEmp = binding.workspacePath.startsWith('empty-workspace:');
            const cleanFolderName = isEmp ? 'Antigravity (без папки)' : path.basename(binding.workspacePath).replace(/\.code-workspace$/i, '');
            text += `<b>${t('Current Workspace (this chat)')}:</b> 📂 <b>${escapeHtml(cleanFolderName)}</b>\n`;
            if (isEmp) {
                text += `  <i>${t('Path unknown')}</i>\n\n`;
            } else {
                text += `  <code>${escapeHtml(binding.workspacePath)}</code>\n\n`;
            }
        } else {
            text += `<b>${t('Current Workspace (this chat)')}:</b> ⚪ ${t('None')}\n\n`;
        }

        const activeWindows = await scanActiveWindows();

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
                let sessionInfo: { title: string; hasActiveChat: boolean } | null = null;
                if (win.workspacePath) {
                    try {
                        const cdp = bridge.pool.getConnected(win.projectName);
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
                const pathStr = win.workspacePath && !isEmp ? `<code>${escapeHtml(win.workspacePath)}</code>` : `<i>${t('Path unknown')}</i>`;
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

                // Add simple connect button
                keyboard.text(`🔌 ${cleanName}`, `switch_window:${shortId}`).row();
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

        if (inactive.length === 0) {
            await replyHtml(ctx, `No inactive sessions older than <b>${days}</b> day(s).`);
            return;
        }

        const list = inactive.slice(0, 20).map(({ binding, session }) => {
            const label = session?.displayName ?? binding.workspacePath;
            return `• ${escapeHtml(label)}`;
        }).join('\n');
        const extra = inactive.length > 20 ? `\n…and ${inactive.length - 20} more` : '';

        const keyboard = new InlineKeyboard()
            .text('📦 Archive', `${CLEANUP_ARCHIVE_BTN}:${days}`)
            .text('🗑 Delete', `${CLEANUP_DELETE_BTN}:${days}`)
            .text('❌ Cancel', CLEANUP_CANCEL_BTN);

        await replyHtml(ctx,
            `<b>🧹 Cleanup</b>\n\n` +
            `Found <b>${inactive.length}</b> session(s) older than <b>${days}</b> day(s):\n\n` +
            `${list}${extra}\n\n` +
            `Choose an action:`,
            keyboard,
        );
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
        ch: TelegramChannel,
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
        const openWindow = activeWindows.find(win => {
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
                        const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(pages, 0, projectName || '', targetChannelStr, lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
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
                    const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(pages, 0, projectName, targetChannelStr, lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
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
                const { text: uiText, keyboard: uiKeyboard } = buildPlanNotificationUI(info, projectName, targetChannelStr || String(ch.chatId));
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

            const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(pages, page, projectName, targetChannelStr || String(ch.chatId), lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
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
        if (data.startsWith(CLEANUP_ARCHIVE_BTN) || data.startsWith(CLEANUP_DELETE_BTN) || data === CLEANUP_CANCEL_BTN) {
            if (data === CLEANUP_CANCEL_BTN) {
                try { await ctx.editMessageText('Cleanup cancelled.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: 'Cancelled' });
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

    // =============================================================================
    // Text message handler (main chat flow)
    // =============================================================================

    bot.on('message:text', async (ctx) => {
        const ch = getChannel(ctx);
        const key = channelKey(ch);
        const text = ctx.message.text.trim();

        if (!text) return;

        // Plan edit interception
        const pendingPlanEdit = planEditPendingChannels.get(key);
        if (pendingPlanEdit) {
            if (text === '/cancel') {
                planEditPendingChannels.delete(key);
                await ctx.reply('Plan edit cancelled.');
                return;
            }

            planEditPendingChannels.delete(key);
            const editPrompt = `Please revise the plan based on the following feedback:\n\n${text}`;
            const resolved = await resolveWorkspaceAndCdp(ch);
            const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
            if (!cdp) {
                await ctx.reply('Not connected to CDP.');
                return;
            }
            await ctx.reply('Sending plan edit...');
            promptDispatcher.send({
                channel: ch,
                prompt: editPrompt,
                cdp,
                inboundImages: [],
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            }).catch((e) => logger.error('[planEdit] dispatch failed:', e));
            return;
        }

        // Check if it looks like a text command
        const parsed = parseMessageContent(text);
        if (parsed.isCommand && parsed.commandName) {
            if (parsed.commandName === 'autoaccept') {
                const result = bridge.autoAccept.handle(parsed.args?.[0]);
                await ctx.reply(result.message);
                return;
            }

            if (parsed.commandName === 'screenshot') {
                await handleScreenshot(
                    async (input, caption) => { await ctx.replyWithPhoto(input, { caption }); },
                    async (text) => { await ctx.reply(text); },
                    getCurrentCdp(bridge),
                );
                return;
            }

            if (parsed.commandName === 'status') {
                await handleStatus(ctx);
                return;
            }

            const result = await slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);
            await ctx.reply(result.message);

            if (result.prompt) {
                const cdp = getCurrentCdp(bridge);
                if (cdp) {
                    promptDispatcher.send({
                        channel: ch,
                        prompt: result.prompt,
                        cdp,
                        inboundImages: [],
                        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
                    }).catch((e) => logger.error('[slashCmd] dispatch failed:', e));
                } else {
                    await ctx.reply('Not connected to CDP. Send a message first to connect to a project.');
                }
            }
            return;
        }

        // Regular message — route to Antigravity
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        // ── Concurrency gate: check if workspace is busy ────────────────────
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        if (busy) {
            const normalized = normalizeForHash(text);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessage(text).catch((err) => {
                logger.error('[TelegramQueue] Failed to inject queued message:', err);
                ctx.reply(`❌ Failed to send message to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        const session = chatSessionRepo.findByChannelId(key);
        if (session?.displayName) {
            registerApprovalSessionChannel(bridge, resolved.projectName, session.displayName, ch);
        }



        const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
        if (userMsgDetector) userMsgDetector.addEchoHash(text);

        // Fire-and-forget: do NOT await so Grammy can process the next update immediately.
        // The lock is set synchronously inside send() before its first await,
        // so isBusy() will see it when the next message handler runs.
        promptDispatcher.send({
            channel: ch,
            prompt: text,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[textMsg] dispatch failed:', e));
    });

    // Media group (album) aggregator
    interface PendingMediaGroup {
        timer: NodeJS.Timeout;
        ch: TelegramChannel;
        photos: Array<{ file_id: string; file_size?: number }>;
        documents: Array<{ file_id: string; file_size?: number; mime_type?: string; file_name?: string }>;
        captions: string[];
        messageIds: number[];
        ctx: Context;
    }

    const pendingMediaGroups = new Map<string, PendingMediaGroup>();

    const handleMediaGroup = async (mediaGroupId: string, ch: TelegramChannel, ctx: Context) => {
        const group = pendingMediaGroups.get(mediaGroupId);
        if (!group) return;
        pendingMediaGroups.delete(mediaGroupId);

        const caption = group.captions.filter(Boolean).join('\n') || 'Please review the attached images and respond accordingly.';
        const resolved = await resolveWorkspaceAndCdp(group.ch);
        if (!resolved.ok) { await group.ctx.reply(resolved.message); return; }

        const allItems = [...group.photos, ...group.documents];
        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            allItems,
            String(group.messageIds[0]),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
        const busy = promptDispatcher.isBusy(group.ch, resolved.cdp);
        if (busy) {
            const normalized = normalizeForHash(caption);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessageWithImageFiles(caption, inboundImages.map(i => i.localPath))
                .catch((err) => {
                    logger.error('[TelegramQueue:mediaGroup] Failed to inject:', err);
                    group.ctx.reply(`❌ Failed to send album to IDE: ${err.message}`).catch(() => {});
                    telegramSentPrompts.delete(normalized);
                })
                .finally(() => {
                    cleanupInboundImageAttachments(inboundImages).catch(() => {});
                });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        promptDispatcher.send({
            channel: group.ch,
            prompt: caption,
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[mediaGroup] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    };

    // Photo message handler
    bot.on('message:photo', async (ctx) => {
        const ch = getChannel(ctx);
        const photos = ctx.message.photo;
        if (!photos || photos.length === 0) return;

        const largest = photos[photos.length - 1];
        const caption = ctx.message.caption?.trim() || '';

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
            let group = pendingMediaGroups.get(mediaGroupId);
            if (!group) {
                group = {
                    timer: null as any,
                    ch,
                    photos: [],
                    documents: [],
                    captions: [],
                    messageIds: [],
                    ctx,
                };
                pendingMediaGroups.set(mediaGroupId, group);
            }
            group.photos.push(largest);
            if (caption) group.captions.push(caption);
            group.messageIds.push(ctx.message.message_id);
            if (group.timer) clearTimeout(group.timer);
            group.timer = setTimeout(() => handleMediaGroup(mediaGroupId, ch, ctx), 800);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) { await ctx.reply(resolved.message); return; }

        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            [largest],
            String(ctx.message.message_id),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        if (busy) {
            const promptText = caption || 'Please review the attached images and respond accordingly.';
            const normalized = normalizeForHash(promptText);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessageWithImageFiles(promptText, inboundImages.map(i => i.localPath))
                .catch((err) => {
                    logger.error('[TelegramQueue:photo] Failed to inject:', err);
                    ctx.reply(`❌ Failed to send photo to IDE: ${err.message}`).catch(() => {});
                    telegramSentPrompts.delete(normalized);
                })
                .finally(() => {
                    cleanupInboundImageAttachments(inboundImages).catch(() => {});
                });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        // Fire-and-forget; cleanup images after dispatch completes (not immediately)
        promptDispatcher.send({
            channel: ch,
            prompt: caption || 'Please review the attached images and respond accordingly.',
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[photoMsg] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    });

    // Document (file) message handler - handle uncompressed images
    bot.on('message:document', async (ctx) => {
        const doc = ctx.message.document;
        if (!doc) return;

        // Check if the document is an image
        if (!isImageAttachment(doc.mime_type, doc.file_name)) {
            return;
        }

        const ch = getChannel(ctx);
        const caption = ctx.message.caption?.trim() || '';

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
            let group = pendingMediaGroups.get(mediaGroupId);
            if (!group) {
                group = {
                    timer: null as any,
                    ch,
                    photos: [],
                    documents: [],
                    captions: [],
                    messageIds: [],
                    ctx,
                };
                pendingMediaGroups.set(mediaGroupId, group);
            }
            group.documents.push(doc);
            if (caption) group.captions.push(caption);
            group.messageIds.push(ctx.message.message_id);
            if (group.timer) clearTimeout(group.timer);
            group.timer = setTimeout(() => handleMediaGroup(mediaGroupId, ch, ctx), 800);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) { await ctx.reply(resolved.message); return; }

        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            [doc],
            String(ctx.message.message_id),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        if (busy) {
            const promptText = caption || 'Please review the attached images and respond accordingly.';
            const normalized = normalizeForHash(promptText);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessageWithImageFiles(promptText, inboundImages.map(i => i.localPath))
                .catch((err) => {
                    logger.error('[TelegramQueue:document] Failed to inject:', err);
                    ctx.reply(`❌ Failed to send file to IDE: ${err.message}`).catch(() => {});
                    telegramSentPrompts.delete(normalized);
                })
                .finally(() => {
                    cleanupInboundImageAttachments(inboundImages).catch(() => {});
                });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        promptDispatcher.send({
            channel: ch,
            prompt: caption || 'Please review the attached images and respond accordingly.',
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[documentMsg] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    });

    // Voice message handler (voice-to-prompt via local Whisper transcription)
    bot.on('message:voice', async (ctx) => {
        const ch = getChannel(ctx);

        const whisperIssue = checkWhisperAvailability();
        if (whisperIssue) {
            await ctx.reply(whisperIssue);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        await ctx.reply('🎙️ Transcribing voice message...');

        let voicePath: string;
        try {
            voicePath = await downloadTelegramVoice(bot.api, config.telegramBotToken, ctx.message.voice);
        } catch (error: any) {
            logger.error('[Voice] Download failed:', error?.message || error);
            await ctx.reply('❌ Could not download voice message. Please try again.');
            return;
        }

        const transcript = await transcribeVoice(voicePath);
        if (!transcript) {
            await ctx.reply('❌ Could not transcribe voice message. Please try again or type your prompt.');
            return;
        }

        // Check if transcription is a slash command
        const parsed = parseMessageContent(transcript);
        if (parsed.isCommand && parsed.commandName) {
            const result = await slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);
            await ctx.reply(`🎙️ "${transcript}"\n\n${result.message}`);

            if (result.prompt) {
                const cdp = getCurrentCdp(bridge);
                if (cdp) {
                    promptDispatcher.send({
                        channel: ch,
                        prompt: result.prompt,
                        cdp,
                        inboundImages: [],
                        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
                    }).catch((e) => logger.error('[voiceCmd] dispatch failed:', e));
                }
            }
            return;
        }

        await ctx.reply(`📝 "${transcript}"`);

        // ── Concurrency gate ────────────────────────────────────────────────
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        if (busy) {
            const normalized = normalizeForHash(transcript);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessage(transcript).catch((err) => {
                logger.error('[TelegramQueue:voice] Failed to inject:', err);
                ctx.reply(`❌ Failed to send voice transcription to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
        if (userMsgDetector) userMsgDetector.addEchoHash(transcript);

        // Fire-and-forget: same pattern as text handler
        promptDispatcher.send({
            channel: ch,
            prompt: transcript,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[voiceMsg] dispatch failed:', e));
    });

    // Proactively connect to all existing workspace bindings on startup
    try {
        const bindings = workspaceBindingRepo.findAll();
        logger.info(`[startup] Found ${bindings.length} workspace binding(s). Connecting proactively...`);
        for (const binding of bindings) {
            const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            const channel: TelegramChannel = {
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
                let targetChannel: TelegramChannel | null = null;
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
                    const ch: TelegramChannel = {
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
