import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { RESPONSE_SELECTORS } from '../utils/domSelectors';

/** User message information detected from the DOM */
export interface UserMessageInfo {
    /** Message text content */
    text: string;
    /** Title of the chat/conversation */
    chatTitle?: string;
    /** Index of the message in the DOM list (1-based count) */
    index?: number;
    /** Timestamp text of the message if available */
    timestamp?: string;
}

export interface UserMessageDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when a new user message is detected. Return false if skipped/not accepted. */
    onUserMessage: (info: UserMessageInfo) => boolean | void;
    /** SQLite database connection for deduplication */
    db?: Database.Database;
}

/**
 * Script to detect the latest user message in the Antigravity chat.
 *
 * Antigravity user message DOM structure:
 *   <div class="bg-gray-500/15 p-2 rounded-lg w-full text-sm select-text">
 *     <div class="flex flex-row items-end gap-2">
 *       <div class="flex-1 flex flex-col gap-2">
 *         <div>
 *           <div class="whitespace-pre-wrap text-sm" style="word-break: break-word;">
 *             {user message text}
 *           </div>
 *         </div>
 *       </div>
 *       <div> <!-- undo button --> </div>
 *     </div>
 *   </div>
 */
const DETECT_USER_MESSAGE_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;

    const header = panel ? panel.querySelector('div[class*="border-b"]') : null;
    const titleEl = header ? header.querySelector('div[class*="text-ellipsis"]') : null;
    const chatTitle = titleEl ? (titleEl.textContent || '').trim() : '';

    // Strategy A (primary): Query based on the modern data-testid="user-input-step"
    const steps = Array.from(scope.querySelectorAll('[data-testid="user-input-step"], [class*="user-input-step"]'));
    const textEls = Array.from(scope.querySelectorAll(
        '[data-testid="user-input-step"] .whitespace-pre-wrap, [class*="user-input-step"] .whitespace-pre-wrap'
    ));

    // Fallback to the older bg-gray-500/15 bubble style
    const legacyEls = Array.from(scope.querySelectorAll(
        '[class*="bg-gray-500/15"][class*="select-text"] .whitespace-pre-wrap'
    ));

    const combinedEls = [...textEls, ...legacyEls];

    if (combinedEls.length > 0) {
        const lastTextEl = combinedEls[combinedEls.length - 1];
        const text = (lastTextEl.textContent || '').trim();
        
        let timestamp = '';
        const lastStep = steps[steps.length - 1];
        if (lastStep) {
            const timeEl = lastStep.querySelector('.absolute.bottom-1.right-1, [class*="bottom-1"][class*="right-1"]');
            if (timeEl) {
                timestamp = (timeEl.textContent || '').trim();
            }
        }

        if (text.length > 0) {
            return {
                text,
                chatTitle,
                index: combinedEls.length,
                timestamp
            };
        }
        return { text: '', chatTitle, index: 0, timestamp: '' };
    }

    // Strategy B (fallback)
    const userBubbles = Array.from(scope.querySelectorAll(
        '[data-testid="user-input-step"], [class*="user-input-step"], [class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]'
    )).filter(el => !el.querySelector('[data-testid="user-input-step"], [class*="user-input-step"], [class*="bg-gray-500/15"][class*="select-text"]'));

    if (userBubbles.length === 0) {
        return { text: '', chatTitle, index: 0, timestamp: '' };
    }

    const lastBubble = userBubbles[userBubbles.length - 1];
    const textEl = lastBubble.querySelector('.whitespace-pre-wrap')
        || lastBubble.querySelector('[style*="word-break"]');

    const text = textEl
        ? (textEl.textContent || '').trim()
        : (lastBubble.textContent || '').trim();

    if (!text || text.length < 1) {
        return { text: '', chatTitle, index: 0, timestamp: '' };
    }

    let timestamp = '';
    const timeEl = lastBubble.querySelector('.absolute.bottom-1.right-1, [class*="bottom-1"][class*="right-1"]');
    if (timeEl) {
        timestamp = (timeEl.textContent || '').trim();
    }

    return {
        text,
        chatTitle,
        index: userBubbles.length,
        timestamp
    };
})()`;

/**
 * Normalize text for echo hash comparison.
 * Trims, collapses whitespace, and takes first 200 chars.
 */
export function normalizeForHash(text: string): string {
    return text.trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Compute a short hash for echo prevention.
 */
function computeEchoHash(text: string): string {
    return createHash('sha256').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

function computeDbHash(chatTitle: string, text: string, index: number): string {
    const combined = `${chatTitle || ''}_${normalizeForHash(text)}_${index}`;
    return createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

/**
 * Detects user messages posted directly in the Antigravity UI (e.g., from a PC).
 * Follows the ApprovalDetector polling pattern.
 */
export class UserMessageDetector {
    private readonly cdpService: CdpService;
    private readonly pollIntervalMs: number;
    private readonly onUserMessage: (info: UserMessageInfo) => boolean | void;
    private readonly db?: Database.Database;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Hash of the last detected message (for duplicate prevention) */
    private lastDetectedHash: string | null = null;
    /** Chat title tracked during the last poll iteration */
    private lastChatTitle: string | null = null;
    /** Message index tracked during the last poll iteration */
    private lastDetectedIndex: number = 0;
    /** Set of echo hashes — messages sent by Remoat that should be ignored */
    private readonly echoHashes = new Set<string>();
    /** Set of all previously detected message hashes (defense-in-depth dedup) */
    private readonly seenHashes = new Set<string>();
    private static readonly MAX_SEEN_HASHES = 50;
    /** True during the first poll — seeds existing DOM state without firing callback */
    private isPriming: boolean = false;

    constructor(options: UserMessageDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onUserMessage = options.onUserMessage;
        this.db = options.db;

        if (this.db) {
            try {
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS seen_user_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        message_hash TEXT NOT NULL UNIQUE,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                `);
                // Clean up hashes older than 24 hours
                this.db.prepare("DELETE FROM seen_user_messages WHERE created_at < datetime('now', '-24 hours')").run();
                logger.debug('[UserMessageDetector] Cleaned up seen_user_messages hashes older than 24h');
            } catch (err) {
                logger.error('[UserMessageDetector] Failed to create or prune seen_user_messages table:', err);
            }
        }
    }

    /**
     * Check if seen_user_messages table is completely empty (first run).
     */
    private isDbEmpty(): boolean {
        if (!this.db) return true;
        try {
            const row = this.db.prepare('SELECT 1 FROM seen_user_messages LIMIT 1').get();
            return !row;
        } catch (err) {
            logger.error('[UserMessageDetector] Error checking if DB is empty:', err);
            return true;
        }
    }

    /**
     * Register a message hash as an echo (sent by Remoat).
     * When this message is detected in the DOM, it will be skipped.
     */
    addEchoHash(text: string): void {
        const hash = computeEchoHash(text);
        this.echoHashes.add(hash);
        // Auto-cleanup: remove after 60s to prevent memory leak
        setTimeout(() => {
            this.echoHashes.delete(hash);
        }, 60000);
    }

    /** Start monitoring. The first poll seeds the current DOM state without firing the callback. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedHash = null;
        this.lastChatTitle = null;
        this.lastDetectedIndex = 0;
        this.seenHashes.clear();
        this.isPriming = true;
        // echoHashes are intentionally NOT cleared — they have their own 60s TTL
        // and keeping them prevents false echo pickup during rapid stop/start cycles.
        this.schedulePoll();
    }

    /** Stop monitoring. */
    stop(): void {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean {
        return this.isRunning;
    }

    /** Add a hash to the seenHashes set, evicting the oldest entry if at capacity. */
    private addToSeenHashes(hash: string): void {
        if (this.seenHashes.size >= UserMessageDetector.MAX_SEEN_HASHES) {
            // Evict the oldest entry (first inserted)
            const oldest = this.seenHashes.values().next().value;
            if (oldest !== undefined) {
                this.seenHashes.delete(oldest);
            }
        }
        this.seenHashes.add(hash);
    }

    /** Schedule the next poll. */
    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    /**
     * Single poll iteration:
     *   1. Get latest user message from DOM
     *   2. Check for duplicates and echoes
     *   3. Notify via callback on new detection
     */
    private async poll(): Promise<void> {
        try {
            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: DETECT_USER_MESSAGE_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            const info: UserMessageInfo | null = result?.result?.value ?? null;

            if (info && info.text) {
                const currentTitle = info.chatTitle || '';
                if (this.lastChatTitle !== null && this.lastChatTitle !== currentTitle) {
                    logger.debug(`[UserMessageDetector] Chat title changed from "${this.lastChatTitle}" to "${currentTitle}". Priming detector.`);
                    this.isPriming = true;
                }
                this.lastChatTitle = currentTitle;

                const echoHash = computeEchoHash(info.text);
                const dbHash = computeDbHash(
                    info.chatTitle || '',
                    info.text,
                    info.index ?? 0
                );
                const preview = info.text.slice(0, 40);

                const wasPriming = this.isPriming;
                if (this.isPriming) {
                    this.isPriming = false;
                }

                const currentIndex = info.index ?? 0;

                // Detect step revert/undo during normal operation
                const isRevert = !wasPriming && currentIndex < this.lastDetectedIndex;
                if (isRevert) {
                    logger.debug(`[UserMessageDetector] Detected revert/undo (index decreased from ${this.lastDetectedIndex} to ${currentIndex}). Priming state.`);
                    this.lastDetectedHash = dbHash;
                    this.lastDetectedIndex = currentIndex;
                    this.seenHashes.clear();
                    this.addToSeenHashes(dbHash);
                    return;
                }

                // Check in DB using the context-aware dbHash (ONLY during startup/priming)
                let alreadySeenInDb = false;
                if (wasPriming && this.db) {
                    try {
                        const row = this.db.prepare('SELECT 1 FROM seen_user_messages WHERE message_hash = ?').get(dbHash);
                        if (row) {
                            alreadySeenInDb = true;
                        }
                    } catch (err) {
                        logger.error('[UserMessageDetector] DB query error:', err);
                    }
                }

                if (alreadySeenInDb) {
                    this.lastDetectedHash = dbHash;
                    this.lastDetectedIndex = currentIndex;
                    this.addToSeenHashes(dbHash);
                    if (wasPriming) {
                        logger.debug(`[UserMessageDetector] Primed with already seen message (in DB): "${preview}..."`);
                    }
                    return;
                }

                // First poll (and not in DB): seed the current DOM state without firing callback
                // But only if the database is completely empty (first run). If the DB has history,
                // we check if active generation is running. If not, we still prime it to prevent
                // mirroring old message history upon workspace connection.
                if (wasPriming) {
                    this.lastDetectedHash = dbHash;
                    this.lastDetectedIndex = currentIndex;
                    this.addToSeenHashes(dbHash);
                    if (this.db) {
                        try {
                            this.db.prepare('INSERT OR IGNORE INTO seen_user_messages (message_hash) VALUES (?)').run(dbHash);
                            this.db.prepare("DELETE FROM seen_user_messages WHERE created_at < datetime('now', '-24 hours')").run();
                        } catch (err) {
                            logger.error('[UserMessageDetector] DB insert/cleanup error:', err);
                        }
                    }
                    logger.debug(`[UserMessageDetector] Primed with existing message: "${preview}..."`);
                    return;
                }

                // Skip if same as last detected message in memory
                if (dbHash === this.lastDetectedHash) return;

                // Skip if already seen (defense-in-depth dedup)
                if (this.seenHashes.has(dbHash)) {
                    logger.debug(`[UserMessageDetector] seenHash hit, skipping: "${preview}..."`);
                    this.lastDetectedHash = dbHash;
                    this.lastDetectedIndex = currentIndex;
                    return;
                }

                // Skip if this is an echo (sent by Remoat) — check using echoHash
                if (this.echoHashes.has(echoHash)) {
                    logger.debug(`[UserMessageDetector] Echo hash match, skipping: "${preview}..."`);
                    this.lastDetectedHash = dbHash;
                    this.lastDetectedIndex = currentIndex;
                    this.addToSeenHashes(dbHash);
                    if (this.db) {
                        try {
                            this.db.prepare('INSERT OR IGNORE INTO seen_user_messages (message_hash) VALUES (?)').run(dbHash);
                            this.db.prepare("DELETE FROM seen_user_messages WHERE created_at < datetime('now', '-24 hours')").run();
                        } catch (err) {
                            logger.error('[UserMessageDetector] DB insert/cleanup error:', err);
                        }
                    }
                    return;
                }

                logger.debug(`[UserMessageDetector] New message detected: "${preview}..."`);
                const accepted = this.onUserMessage(info);
                if (accepted !== false) {
                    this.lastDetectedHash = dbHash;
                    this.lastDetectedIndex = currentIndex;
                    this.addToSeenHashes(dbHash);
                    if (this.db) {
                        try {
                            this.db.prepare('INSERT OR IGNORE INTO seen_user_messages (message_hash) VALUES (?)').run(dbHash);
                            this.db.prepare("DELETE FROM seen_user_messages WHERE created_at < datetime('now', '-24 hours')").run();
                        } catch (err) {
                            logger.error('[UserMessageDetector] DB insert/cleanup error:', err);
                        }
                    }
                } else {
                    logger.debug(`[UserMessageDetector] Callback rejected message: "${preview}...", not updating lastDetectedHash`);
                }
            } else {
                // No message, but we can still check if chatTitle changed
                if (info) {
                    const currentTitle = info.chatTitle || '';
                    if (this.lastChatTitle !== null && this.lastChatTitle !== currentTitle) {
                        logger.debug(`[UserMessageDetector] Chat title changed from "${this.lastChatTitle}" to "${currentTitle}". Priming detector.`);
                        this.isPriming = true;
                    }
                    this.lastChatTitle = currentTitle;
                }

                // Clear priming flag even if DOM is empty (e.g., new/empty chat)
                if (this.isPriming) {
                    this.isPriming = false;
                    logger.debug('[UserMessageDetector] Primed with empty DOM');
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) return;
            logger.error('[UserMessageDetector] Error during polling:', error);
        }
    }
}
