import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { escapeHtml } from '../utils/telegramFormatter';
import { ApprovalDetector, ApprovalInfo, classifyApproval } from './approvalDetector';
import { AutoAcceptService } from './autoAcceptService';
import { CdpConnectionPool } from './cdpConnectionPool';
import { CdpService } from './cdpService';
import { ErrorPopupDetector, ErrorPopupInfo } from './errorPopupDetector';
import { PlanningDetector, PlanningInfo } from './planningDetector';
import { QuotaService } from './quotaService';
import { UserMessageDetector, UserMessageInfo } from './userMessageDetector';
import { buildPlanNotificationUI } from '../ui/planUi';
import { loadConfig } from '../utils/config';
import { IMessengerPort, ChannelContext, AbstractButton } from './messengerPort';

export interface CdpBridge {
    pool: CdpConnectionPool;
    quota: QuotaService;
    autoAccept: AutoAcceptService;
    lastActiveWorkspace: string | null;
    lastActiveChannel: ChannelContext | null;
    approvalChannelByWorkspace: Map<string, ChannelContext>;
    approvalChannelBySession: Map<string, ChannelContext>;
    messenger: IMessengerPort | null;
    botToken: string;
}

const APPROVE_ACTION_PREFIX = 'app_a';
const ALWAYS_ALLOW_ACTION_PREFIX = 'alw_a';
const DENY_ACTION_PREFIX = 'dny_a';
const PLANNING_OPEN_ACTION_PREFIX = 'pln_o';
const PLANNING_PROCEED_ACTION_PREFIX = 'pln_p';
const ERROR_POPUP_DISMISS_ACTION_PREFIX = 'err_d';
const ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX = 'err_c';
const ERROR_POPUP_RETRY_ACTION_PREFIX = 'err_r';

function truncateToBytes(str: string, maxBytes: number): string {
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    let sliced = buf.subarray(0, maxBytes).toString('utf8');
    if (sliced.endsWith('\uFFFD') || (sliced.length > 0 && sliced.codePointAt(sliced.length - 1) === 0xFFFD)) {
        sliced = sliced.slice(0, -1);
    }
    return sliced;
}

function buildCustomIdWithLimit(
    prefix: string,
    projectName: string,
    channelId?: string,
): string {
    const channelPart = channelId && channelId.trim().length > 0 ? `:${channelId}` : '';
    const maxProjectNameBytes = 64 - prefix.length - channelPart.length - 1;
    let safeProjectName = projectName;
    if (Buffer.from(projectName, 'utf8').length > maxProjectNameBytes) {
        safeProjectName = truncateToBytes(projectName, maxProjectNameBytes);
    }
    return channelPart ? `${prefix}:${safeProjectName}${channelPart}` : `${prefix}:${safeProjectName}`;
}

function normalizeSessionTitle(title: string): string {
    return title.trim().toLowerCase();
}

function buildSessionRouteKey(projectName: string, sessionTitle: string): string {
    return `${projectName}::${normalizeSessionTitle(sessionTitle)}`;
}

const GET_CURRENT_CHAT_TITLE_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    if (!panel) return '';
    const header = panel.querySelector('div[class*="border-b"]');
    if (!header) return '';
    const titleEl = header.querySelector('div[class*="text-ellipsis"]');
    const title = titleEl ? (titleEl.textContent || '').trim() : '';
    if (!title || title === 'Agent') return '';
    return title;
})()`;

export async function getCurrentChatTitle(cdp: CdpService): Promise<string | null> {
    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression: GET_CURRENT_CHAT_TITLE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id,
            });
            const value = result?.result?.value;
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        } catch (e) { logger.debug('[CdpBridgeManager] Title probe failed, continuing:', e); }
    }
    return null;
}

export function registerApprovalWorkspaceChannel(
    bridge: CdpBridge,
    projectName: string,
    channel: ChannelContext,
): void {
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function registerApprovalSessionChannel(
    bridge: CdpBridge,
    projectName: string,
    sessionTitle: string,
    channel: ChannelContext,
): void {
    if (!sessionTitle || sessionTitle.trim().length === 0) return;
    bridge.approvalChannelBySession.set(buildSessionRouteKey(projectName, sessionTitle), channel);
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function resolveApprovalChannelForCurrentChat(
    bridge: CdpBridge,
    projectName: string,
    currentChatTitle: string | null,
): ChannelContext | null {
    if (currentChatTitle && currentChatTitle.trim().length > 0) {
        const key = buildSessionRouteKey(projectName, currentChatTitle);
        const sessionChannel = bridge.approvalChannelBySession.get(key);
        if (sessionChannel) return sessionChannel;
    }
    return bridge.approvalChannelByWorkspace.get(projectName) ?? null;
}

export function buildApprovalCustomId(
    action: 'approve' | 'always_allow' | 'deny',
    projectName: string,
    channelId?: string,
): string {
    const prefix = action === 'approve'
        ? APPROVE_ACTION_PREFIX
        : action === 'always_allow'
            ? ALWAYS_ALLOW_ACTION_PREFIX
            : DENY_ACTION_PREFIX;
    return buildCustomIdWithLimit(prefix, projectName, channelId);
}

export function parseApprovalCustomId(customId: string): { action: 'approve' | 'always_allow' | 'deny'; projectName: string | null; channelId: string | null } | null {
    const pairs = [
        ['approve', APPROVE_ACTION_PREFIX],
        ['always_allow', ALWAYS_ALLOW_ACTION_PREFIX],
        ['deny', DENY_ACTION_PREFIX],
        ['approve', 'approve_action'],
        ['always_allow', 'always_allow_action'],
        ['deny', 'deny_action'],
    ] as const;
    for (const [action, prefix] of pairs) {
        if (customId === prefix) return { action, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring(`${prefix}:`.length);
            const [projectName, channelId] = rest.split(':');
            return { action, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

export function buildPlanningCustomId(
    action: 'open' | 'proceed',
    projectName: string,
    channelId?: string,
): string {
    const prefix = action === 'open' ? PLANNING_OPEN_ACTION_PREFIX : PLANNING_PROCEED_ACTION_PREFIX;
    return buildCustomIdWithLimit(prefix, projectName, channelId);
}

export function parsePlanningCustomId(customId: string): { action: 'open' | 'proceed'; projectName: string | null; channelId: string | null } | null {
    const pairs = [
        ['open', PLANNING_OPEN_ACTION_PREFIX],
        ['proceed', PLANNING_PROCEED_ACTION_PREFIX],
        ['open', 'planning_open_action'],
        ['proceed', 'planning_proceed_action'],
    ] as const;
    for (const [action, prefix] of pairs) {
        if (customId === prefix) return { action, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring(`${prefix}:`.length);
            const [projectName, channelId] = rest.split(':');
            return { action, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

export function buildErrorPopupCustomId(
    action: 'dismiss' | 'copy_debug' | 'retry',
    projectName: string,
    channelId?: string,
): string {
    const prefix = action === 'dismiss'
        ? ERROR_POPUP_DISMISS_ACTION_PREFIX
        : action === 'copy_debug'
            ? ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX
            : ERROR_POPUP_RETRY_ACTION_PREFIX;
    return buildCustomIdWithLimit(prefix, projectName, channelId);
}

export function parseErrorPopupCustomId(customId: string): { action: 'dismiss' | 'copy_debug' | 'retry'; projectName: string | null; channelId: string | null } | null {
    const pairs = [
        ['dismiss', ERROR_POPUP_DISMISS_ACTION_PREFIX],
        ['copy_debug', ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX],
        ['retry', ERROR_POPUP_RETRY_ACTION_PREFIX],
        ['dismiss', 'error_popup_dismiss_action'],
        ['copy_debug', 'error_popup_copy_debug_action'],
        ['retry', 'error_popup_retry_action'],
    ] as const;
    for (const [action, prefix] of pairs) {
        if (customId === prefix) return { action, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring(`${prefix}:`.length);
            const [projectName, channelId] = rest.split(':');
            return { action, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

export function initCdpBridge(): CdpBridge {
    const pool = new CdpConnectionPool({
        cdpCallTimeout: 15000,
        maxReconnectAttempts: 3,
        reconnectDelayMs: 3000,
    });

    const quota = new QuotaService();
    const conf = loadConfig();
    const autoAccept = new AutoAcceptService({
        enabled: conf.autoApprove,
        fileEdits: conf.autoApproveFileEdits,
        consoleCommands: conf.autoApproveConsoleCommands,
        readAccess: conf.autoApproveReadAccess,
        urlAccess: conf.autoApproveUrlAccess,
        otherRequests: conf.autoApproveOtherRequests,
    });

    return {
        pool,
        quota,
        autoAccept,
        lastActiveWorkspace: null,
        lastActiveChannel: null,
        approvalChannelByWorkspace: new Map(),
        approvalChannelBySession: new Map(),
        messenger: null,
        botToken: '',
    };
}

export function getCurrentCdp(bridge: CdpBridge): CdpService | null {
    if (bridge.lastActiveWorkspace) {
        const cdp = bridge.pool.getConnected(bridge.lastActiveWorkspace);
        if (cdp) return cdp;
    }
    // Fallback: return any connected workspace
    const activeNames = bridge.pool.getActiveWorkspaceNames();
    if (activeNames.length > 0) {
        return bridge.pool.getConnected(activeNames[0]);
    }
    return null;
}

interface DeferredApproval {
    info: ApprovalInfo;
    isAutoApproved: boolean;
}
const deferredFileApprovals = new Map<string, DeferredApproval>();

export async function flushDeferredApproval(
    bridge: CdpBridge,
    projectName: string,
    cdp: CdpService,
): Promise<void> {
    const deferred = deferredFileApprovals.get(projectName);
    if (!deferred) return;

    deferredFileApprovals.delete(projectName);
    const { info, isAutoApproved } = deferred;

    const currentChatTitle = await getCurrentChatTitle(cdp);
    const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

    if (!targetChannel || !bridge.messenger) {
        logger.warn(`[ApprovalDetector:${projectName}] flushDeferredApproval skipped — no channel or messenger port connected`);
        return;
    }

    if (isAutoApproved) {
        const text = `✅ <b>Auto-approved (File Edits)</b>\nFile changes were automatically approved during generation.\n<b>Workspace:</b> ${escapeHtml(projectName)}`;
        await bridge.messenger.sendMessage(targetChannel, text);
    } else {
        const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);
        
        let text = `🔔 <b>Approval Required</b>\n\n`;
        if (info.description) text += `${escapeHtml(info.description)}\n\n`;
        text += `<b>Approve:</b> ${escapeHtml(info.approveText)}\n`;
        if (info.alwaysAllowText) text += `<b>Always:</b> ${escapeHtml(info.alwaysAllowText)}\n`;
        text += `<b>Deny:</b> ${escapeHtml(info.denyText || '(None)')}\n`;
        text += `<b>Workspace:</b> ${escapeHtml(projectName)}`;

        const approveLabel = info.approveText.replace(/[⌃⌥⇧⏎⌘\u2318\u2325\u21B5]+/g, '').trim() || 'Allow';
        const denyLabel = info.denyText || 'Deny';

        const buttons: AbstractButton[] = [
            { text: `✅ ${approveLabel}`, action: buildApprovalCustomId('approve', projectName, targetChannelStr) }
        ];
        if (info.alwaysAllowText) {
            buttons.push({ text: '✅ Allow Chat', action: buildApprovalCustomId('always_allow', projectName, targetChannelStr) });
        }
        buttons.push({ text: `❌ ${denyLabel}`, action: buildApprovalCustomId('deny', projectName, targetChannelStr) });

        const msgId = await bridge.messenger.sendMessage(targetChannel, text, buttons);
        if (msgId) {
            const key = `${info.approveText}::${info.description}`;
            const db = (bridge as any).db;
            if (db) {
                try {
                    db.prepare(`
                        INSERT INTO active_approvals (project_name, approval_key, message_id, chat_id)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(project_name) DO UPDATE SET
                            approval_key = excluded.approval_key,
                            message_id = excluded.message_id,
                            chat_id = excluded.chat_id
                    `).run(projectName, key, msgId, String(targetChannel.chatId));
                } catch (err) {
                    logger.error('[ApprovalDetector] Failed to save active approval to DB:', err);
                }
            }
        }
    }
}

export function ensureApprovalDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getApprovalDetector(projectName);
    if (existing && existing.isActive()) return;

    const db = (bridge as any).db;

    if (db) {
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS active_approvals (
                    project_name TEXT NOT NULL PRIMARY KEY,
                    approval_key TEXT NOT NULL,
                    message_id INTEGER NOT NULL,
                    chat_id TEXT NOT NULL
                )
            `);
        } catch (err) {
            logger.error('[ApprovalDetector] Failed to create active_approvals table:', err);
        }
    }

    let lastMessageId: number | null = null;
    let lastMessageChatId: number | string | null = null;

    const detector = new ApprovalDetector({
        cdpService: cdp,
        pollIntervalMs: 2000,
        onResolved: async () => {
            let msgId = lastMessageId;
            let chatId = lastMessageChatId;

            if (db) {
                try {
                    const row = db.prepare('SELECT message_id, chat_id FROM active_approvals WHERE project_name = ?').get(projectName) as any;
                    if (row) {
                        msgId = row.message_id;
                        chatId = row.chat_id;
                        db.prepare('DELETE FROM active_approvals WHERE project_name = ?').run(projectName);
                    }
                } catch (err) {
                    logger.error('[ApprovalDetector] Failed to clean active approval from DB:', err);
                }
            }

            if (!msgId || !chatId || !bridge.messenger) return;
            
            lastMessageId = null;
            lastMessageChatId = null;

            if (bridge.messenger.cleanMessageButtons) {
                try {
                    await bridge.messenger.cleanMessageButtons({ chatId: Number(chatId) }, msgId);
                } catch (err) {
                    logger.debug('[ApprovalDetector] cleanMessageButtons failed:', err);
                }
            }
        },
        onApprovalRequired: async (info: ApprovalInfo) => {
            logger.debug(`[ApprovalDetector:${projectName}] Approval detected, info: ${JSON.stringify(info)}`);

            logger.debug(`[ApprovalDetector:${projectName}] Getting current chat title...`);
            const currentChatTitle = await getCurrentChatTitle(cdp);
            logger.debug(`[ApprovalDetector:${projectName}] Current chat title: ${currentChatTitle}`);

            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);
            logger.debug(`[ApprovalDetector:${projectName}] Resolved target channel: ${JSON.stringify(targetChannel)}`);

            if (!targetChannel || !bridge.messenger) {
                logger.warn(`[ApprovalDetector:${projectName}] Skipped — no target channel or messenger port (messenger exists: ${!!bridge.messenger})`);
                return;
            }

            const approvalType = classifyApproval(info);
            const isGenerating = cdp.isCurrentlyGenerating() || !!info.isGenerating;

            if (approvalType === 'file_edits') {
                if (isGenerating) {
                    if (bridge.autoAccept.isCategoryEnabled(approvalType)) {
                        const accepted = await detector.alwaysAllowButton() || await detector.approveButton();
                        logger.debug(`[ApprovalDetector:${projectName}] Auto-approved file edit during active generation: ${accepted}`);
                        
                        deferredFileApprovals.set(projectName, {
                            info: {
                                ...info,
                                description: `Auto-approved changes in files (generating...)`
                            },
                            isAutoApproved: true
                        });
                        return;
                    }

                    logger.debug(`[ApprovalDetector:${projectName}] Deferring file approval card (generating): ${info.description}`);
                    deferredFileApprovals.set(projectName, { info, isAutoApproved: false });
                    return;
                } else {
                    deferredFileApprovals.delete(projectName);
                }
            }

            const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);
            const key = `${info.approveText}::${info.description}`;

            // Check if there is already an active approval for this project in the database
            let existingRow: any = null;
            if (db) {
                try {
                    existingRow = db.prepare('SELECT message_id, chat_id, approval_key FROM active_approvals WHERE project_name = ?').get(projectName);
                } catch (err) {
                    logger.error('[ApprovalDetector] Failed to query active approvals from DB:', err);
                }
            }

            if (existingRow) {
                if (existingRow.approval_key === key) {
                    // Same approval, bind to memory and do not send duplicate
                    lastMessageId = existingRow.message_id;
                    lastMessageChatId = existingRow.chat_id;
                    logger.debug(`[ApprovalDetector:${projectName}] Approval already mirrored (msgId: ${existingRow.message_id}), skipping duplicate.`);
                    return;
                } else {
                    // Different approval, remove keyboard from old message and delete it from DB
                    if (bridge.messenger.cleanMessageButtons) {
                        await bridge.messenger.cleanMessageButtons({ chatId: Number(existingRow.chat_id) }, existingRow.message_id)
                            .catch(() => {});
                    }
                    if (db) {
                        try {
                            db.prepare('DELETE FROM active_approvals WHERE project_name = ?').run(projectName);
                        } catch (err) {}
                    }
                }
            }

            if (bridge.autoAccept.isCategoryEnabled(approvalType)) {
                const accepted = await detector.alwaysAllowButton() || await detector.approveButton();
                const categoryLabel = t(approvalType);
                const text = accepted
                    ? `✅ <b>Auto-approved (${categoryLabel})</b>\nAn action was automatically approved.\n<b>Workspace:</b> ${escapeHtml(projectName)}`
                    : `⚠️ <b>Auto-approve failed (${categoryLabel})</b>\nManual approval required.\n<b>Workspace:</b> ${escapeHtml(projectName)}`;
                await bridge.messenger.sendMessage(targetChannel, text);
                if (accepted) return;
            }

            let text = `🔔 <b>Approval Required</b>\n\n`;
            if (info.description) text += `${escapeHtml(info.description)}\n\n`;
            text += `<b>Approve:</b> ${escapeHtml(info.approveText)}\n`;
            if (info.alwaysAllowText) text += `<b>Always:</b> ${escapeHtml(info.alwaysAllowText)}\n`;
            text += `<b>Deny:</b> ${escapeHtml(info.denyText || '(None)')}\n`;
            text += `<b>Workspace:</b> ${escapeHtml(projectName)}`;

            // Use actual button labels from the UI
            const approveLabel = info.approveText.replace(/[⌃⌥⇧⏎⌘\u2318\u2325\u21B5]+/g, '').trim() || 'Allow';
            const denyLabel = info.denyText || 'Deny';

            const buttons: AbstractButton[] = [
                { text: `✅ ${approveLabel}`, action: buildApprovalCustomId('approve', projectName, targetChannelStr) }
            ];
            if (info.alwaysAllowText) {
                buttons.push({ text: '✅ Allow Chat', action: buildApprovalCustomId('always_allow', projectName, targetChannelStr) });
            }
            buttons.push({ text: `❌ ${denyLabel}`, action: buildApprovalCustomId('deny', projectName, targetChannelStr) });

            logger.debug(`[ApprovalDetector:${projectName}] Calling bridge.messenger.sendMessage with text length: ${text.length}`);
            const msgId = await bridge.messenger.sendMessage(targetChannel, text, buttons);
            logger.debug(`[ApprovalDetector:${projectName}] bridge.messenger.sendMessage returned msgId: ${msgId}`);
            if (msgId) {
                lastMessageId = msgId;
                lastMessageChatId = targetChannel.chatId;

                if (db) {
                    try {
                        db.prepare(`
                            INSERT INTO active_approvals (project_name, approval_key, message_id, chat_id)
                            VALUES (?, ?, ?, ?)
                            ON CONFLICT(project_name) DO UPDATE SET
                                approval_key = excluded.approval_key,
                                message_id = excluded.message_id,
                                chat_id = excluded.chat_id
                        `).run(projectName, key, msgId, String(targetChannel.chatId));
                    } catch (err) {
                        logger.error('[ApprovalDetector] Failed to save active approval to DB:', err);
                    }
                }
            }
        },
    });

    if ((cdp as any)._deferredFlushListener) {
        cdp.removeListener('response-monitor:stop', (cdp as any)._deferredFlushListener);
    }
    const stopHandler = async () => {
        await flushDeferredApproval(bridge, projectName, cdp);
    };
    (cdp as any)._deferredFlushListener = stopHandler;
    cdp.on('response-monitor:stop', stopHandler);

    detector.start();
    bridge.pool.registerApprovalDetector(projectName, detector);
    logger.debug(`[ApprovalDetector:${projectName}] Started`);
}

export function ensurePlanningDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getPlanningDetector(projectName);
    if (existing && existing.isActive()) return;

    let lastMessageId: number | null = null;
    let lastMessageChatId: number | string | null = null;

    const detector = new PlanningDetector({
        cdpService: cdp,
        pollIntervalMs: 2000,
        onResolved: () => {
            if (!lastMessageId || !lastMessageChatId || !bridge.messenger) return;
            const msgId = lastMessageId;
            const chatId = lastMessageChatId;
            lastMessageId = null;
            lastMessageChatId = null;
            if (bridge.messenger.cleanMessageButtons) {
                bridge.messenger.cleanMessageButtons({ chatId: Number(chatId) }, msgId)
                    .catch((e) => logger.debug('[PlanningDetector] Markup remove failed (expected if already removed):', e));
            }
        },
        onPlanningRequired: async (info: PlanningInfo) => {
            logger.debug(`[PlanningDetector:${projectName}] Planning detected`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.messenger) return;

            const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);

            const { text, buttons } = buildPlanNotificationUI(info, projectName, targetChannelStr);

            const msgId = await bridge.messenger.sendMessage(targetChannel, text, buttons);
            if (msgId) {
                lastMessageId = msgId;
                lastMessageChatId = targetChannel.chatId;
            }
        },
        onAutoOpened: async (chipText: string) => {
            logger.info(`[PlanningDetector:${projectName}] Auto-opened: "${chipText}"`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.messenger) return;

            const text = `📄 <b>${chipText}</b> opened in <b>${projectName}</b>\n\n<i>Auto-opened — view in Antigravity editor.</i>`;
            await bridge.messenger.sendMessage(targetChannel, text);
        },
    });

    detector.start();
    bridge.pool.registerPlanningDetector(projectName, detector);
    logger.debug(`[PlanningDetector:${projectName}] Started`);
}

export function ensureErrorPopupDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getErrorPopupDetector(projectName);
    if (existing && existing.isActive()) return;

    let lastMessageId: number | null = null;
    let lastMessageChatId: number | string | null = null;

    const detector = new ErrorPopupDetector({
        cdpService: cdp,
        pollIntervalMs: 3000,
        onResolved: () => {
            if (!lastMessageId || !lastMessageChatId || !bridge.messenger) return;
            const msgId = lastMessageId;
            const chatId = lastMessageChatId;
            lastMessageId = null;
            lastMessageChatId = null;
            if (bridge.messenger.cleanMessageButtons) {
                bridge.messenger.cleanMessageButtons({ chatId: Number(chatId) }, msgId)
                    .catch(logger.error);
            }
        },
        onErrorPopup: async (info: ErrorPopupInfo) => {
            logger.debug(`[ErrorPopupDetector:${projectName}] Error popup detected`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.messenger) return;

            const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);
            const bodyText = info.body || t('An error occurred in the Antigravity agent.');

            let text = `❌ <b>${escapeHtml(info.title || 'Agent Error')}</b>\n\n`;
            text += escapeHtml(bodyText.substring(0, 3800)) + `\n\n`;
            text += `<b>Buttons:</b> ${escapeHtml(info.buttons.join(', ') || '(None)')}\n`;
            text += `<b>Workspace:</b> ${escapeHtml(projectName)}`;

            const buttons: AbstractButton[] = [
                { text: '🔇 Dismiss', action: buildErrorPopupCustomId('dismiss', projectName, targetChannelStr) },
                { text: '📋 Copy Debug', action: buildErrorPopupCustomId('copy_debug', projectName, targetChannelStr) },
                { text: '🔄 Retry', action: buildErrorPopupCustomId('retry', projectName, targetChannelStr) }
            ];

            const msgId = await bridge.messenger.sendMessage(targetChannel, text, buttons);
            if (msgId) {
                lastMessageId = msgId;
                lastMessageChatId = targetChannel.chatId;
            }
        },
    });

    detector.start();
    bridge.pool.registerErrorPopupDetector(projectName, detector);
    logger.debug(`[ErrorPopupDetector:${projectName}] Started`);
}

export function ensureUserMessageDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
    onUserMessage: (info: UserMessageInfo) => boolean | void,
): void {
    const existing = bridge.pool.getUserMessageDetector(projectName);
    if (existing && existing.isActive()) return;

    const detector = new UserMessageDetector({
        cdpService: cdp,
        pollIntervalMs: 2000,
        onUserMessage,
        db: (bridge as any).db,
    });

    detector.start();
    bridge.pool.registerUserMessageDetector(projectName, detector);
    logger.debug(`[UserMessageDetector:${projectName}] Started`);
}
