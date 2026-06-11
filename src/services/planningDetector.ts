import { logger } from '../utils/logger';
import { buildClickScript, PLANNING_SELECTORS } from '../utils/domSelectors';
import { CdpService } from './cdpService';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Planning mode button information */
export interface PlanningInfo {
    /** Open button text */
    openText: string;
    /** Proceed button text */
    proceedText: string | null;
    /** Plan title (file name shown in the card) */
    planTitle: string;
    /** Plan summary text */
    planSummary: string;
    /** Plan description (markdown rendered in leading-relaxed container) */
    description: string;
    /**
     * True when the plan was detected as a plain file reference ("Files Modified" row)
     * with no interactive buttons. The Telegram UI should present synthetic Open/Proceed
     * buttons and must NOT call clickOpenButton() since there is nothing to click.
     */
    fileRefMode?: boolean;
    /**
     * True when the card itself is the click target for Open, rather than an internal button.
     */
    openOnCard?: boolean;
}

export interface PlanningDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when planning buttons are detected */
    onPlanningRequired: (info: PlanningInfo) => void;
    /** Callback when a previously detected planning state is resolved (buttons disappeared) */
    onResolved?: () => void;
    /** Callback when a read-only artifact (Walkthrough, Task) is auto-opened (no Proceed button) */
    onAutoOpened?: (chipText: string) => void;
}

/**
 * Selector that matches Antigravity artifact chips.
 *
 * Live DOM inspection confirmed the chip container uses:
 *   div.border.border-gray-500/20.p-2.my-0.5.rounded-lg.transition-colors.flex.flex-col.gap-2.items-start.select-none
 *
 * Key classes:
 *   1. "border-gray-500" — the border colour token (unique to plan chips)
 *   2. "select-none"     — non-selectable text (unique to chip styling)
 *
 * NOTE: "cursor-pointer" is NOT on the chip container — it's only on inner
 * elements. Prior selector was broken because of this false requirement.
 */


/**
 * Detects planning mode buttons (Open/Proceed) in the Antigravity UI via polling.
 *
 * Follows the same polling pattern as ApprovalDetector:
 * - start()/stop() lifecycle
 * - Duplicate notification prevention via lastDetectedKey
 * - CDP error tolerance (continues polling on error)
 */
export class PlanningDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onPlanningRequired: (info: PlanningInfo) => void;
    private onResolved?: () => void;
    private onAutoOpened?: (chipText: string) => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected planning info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full PlanningInfo from the last detection */
    private lastDetectedInfo: PlanningInfo | null = null;
    /** Timestamp of last notification (for cooldown-based dedup) */
    private lastNotifiedAt: number = 0;
    /** Cooldown period in ms to suppress duplicate notifications */
    private static readonly COOLDOWN_MS = 5000;
    
    /** Click-guard state to prevent infinite auto-click loops on collapsed cards */
    private lastClickedChip: { text: string; at: number } | null = null;
    /** Set of already auto-opened artifact texts to prevent infinite loops */
    private autoOpenedChips = new Set<string>();
    private isPaused: boolean = false;

    /**
     * Baseline artifact counts captured when monitoring starts.
     * Artifacts at indices < baseline are from previous sessions and are ignored.
     */
    private baselineNotifyCount: number = 0;
    private baselineCardCount: number = 0;
    private baselineIconCount: number = 0;

    constructor(options: PlanningDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onPlanningRequired = options.onPlanningRequired;
        this.onResolved = options.onResolved;
        this.onAutoOpened = options.onAutoOpened;
    }

    /**
     * Start monitoring.
     *
     * Captures a DOM baseline BEFORE the first poll so that any plan artifacts
     * already in the DOM (e.g. from a prior session) are never treated as new
     * detections and do not produce false-positive Telegram notifications.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
        this.lastClickedChip = null;
        this.autoOpenedChips.clear();
        // Capture baseline before the first poll — runs async but schedules
        // the first poll only after the baseline is safely captured.
        this.resetBaseline().finally(() => {
            if (this.isRunning) this.schedulePoll();
        });
    }

    /**
     * Capture a baseline snapshot of existing artifacts in the DOM.
     * Must be called BEFORE a new message is submitted so that
     * detection only triggers on NEW artifacts from the current session.
     */
    async resetBaseline(): Promise<void> {
        try {
            const result = await this.runEvaluateScript(PLANNING_SELECTORS.CAPTURE_BASELINE_SCRIPT);
            this.baselineNotifyCount = result?.notifyCount ?? 0;
            this.baselineCardCount = result?.cardCount ?? 0;
            this.baselineIconCount = result?.iconCount ?? 0;
            // Reset detection state so new plans can be detected
            this.lastDetectedKey = null;
            this.lastDetectedInfo = null;
            this.lastNotifiedAt = 0;
            this.lastClickedChip = null;
            this.autoOpenedChips.clear();
            logger.debug(
                `[PlanningDetector] Baseline captured: ${this.baselineNotifyCount} notify containers, ` +
                `${this.baselineCardCount} chips, ${this.baselineIconCount} plan icons`,
            );
        } catch (error) {
            logger.error('[PlanningDetector] Failed to capture baseline:', error);
            // On failure, keep existing baselines (safe: won't detect old artifacts)
        }
    }

    /** Get the current baseline counts (for passing to other scripts) */
    getBaseline(): { notifyCount: number; cardCount: number; iconCount: number } {
        return {
            notifyCount: this.baselineNotifyCount,
            cardCount: this.baselineCardCount,
            iconCount: this.baselineIconCount,
        };
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        this.lastClickedChip = null;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Return the last detected planning info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): PlanningInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean {
        return this.isRunning;
    }

    pause(): void {
        this.isPaused = true;
    }

    resume(): void {
        if (!this.isPaused) return;
        this.isPaused = false;
        if (this.isRunning) {
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            this.poll();
        }
    }

    /**
     * Click the Open button via CDP.
     * @param buttonText Text of the button to click (default: detected openText or "Open")
     * @returns true if click succeeded
     */
    async clickOpenButton(buttonText?: string): Promise<boolean> {
        if (this.lastDetectedInfo?.openOnCard) {
            const planTitle = this.lastDetectedInfo.planTitle;
            logger.debug(`[PlanningDetector] Clicking artifact card for plan "${planTitle}" as Open target`);
            const script = `(() => {
                const title = ${JSON.stringify(planTitle)};
                const normalizedTitle = title.toLowerCase().trim();
                const cards = Array.from(document.querySelectorAll('div.artifact-card, div[class*="artifact-card"]'));
                const targetCard = cards.find(card => (card.textContent || '').toLowerCase().includes(normalizedTitle));
                if (targetCard) {
                    targetCard.click();
                    return { ok: true };
                }
                return { ok: false, error: 'Artifact card not found for title: ' + title };
            })()`;
            try {
                const result = await this.runEvaluateScript(script);
                return result?.ok === true;
            } catch (error) {
                logger.error('[PlanningDetector] Error while clicking card:', error);
                return false;
            }
        }
        const text = buttonText ?? this.lastDetectedInfo?.openText ?? 'Open';
        return this.clickButton(text);
    }

    /**
     * Click the Proceed button via CDP.
     * @param buttonText Text of the button to click (default: detected proceedText or "Proceed")
     * @returns true if click succeeded
     */
    async clickProceedButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.proceedText ?? 'Proceed';
        return this.clickButton(text);
    }

    /**
     * Helper to find and read the latest artifact file matching filename from local disk.
     */
    private async findLatestArtifactFile(filename: string): Promise<string | null> {
        const geminiDir = path.join(os.homedir(), '.gemini');
        if (!fs.existsSync(geminiDir)) return null;

        let latestFile: string | null = null;
        let latestMtime = 0;
        const maxAgeMs = 15 * 60 * 1000; // 15 minutes
        const now = Date.now();

        // Standard candidates for files Cascade can create
        const baseName = filename.toLowerCase().trim();
        const candidates = new Set([
            baseName,
            baseName + '.md',
            baseName.replace(/[\s_]+/g, '_') + '.md',
            baseName.replace(/[\s_-]+/g, '-') + '.md'
        ]);

        const searchDirs = [
            path.join(geminiDir, 'antigravity-ide', 'brain'),
            path.join(geminiDir, 'antigravity', 'brain'),
            path.join(geminiDir, 'brain')
        ];

        const scanDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        // Recursively scan session folders (e.g. d896345e-...)
                        const subFiles = fs.readdirSync(fullPath);
                        for (const subFile of subFiles) {
                            const subNorm = subFile.toLowerCase().trim();
                            if (candidates.has(subNorm)) {
                                const subFullPath = path.join(fullPath, subFile);
                                const subStat = fs.statSync(subFullPath);
                                const age = now - subStat.mtimeMs;
                                if (age < maxAgeMs && subStat.mtimeMs > latestMtime) {
                                    latestMtime = subStat.mtimeMs;
                                    latestFile = subFullPath;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error(`[PlanningDetector] Error scanning dir ${dir}:`, e);
            }
        };

        for (const dir of searchDirs) {
            scanDir(dir);
        }

        if (latestFile) {
            try {
                logger.info(`[PlanningDetector] Found matching artifact file on disk: ${latestFile}`);
                return fs.readFileSync(latestFile, 'utf8');
            } catch (e) {
                logger.error(`[PlanningDetector] Error reading file ${latestFile}:`, e);
            }
        }
        return null;
    }

    /**
     * Extract plan content from the DOM after Open has been clicked.
     * @returns Plan content text or null if not found
     */
    async extractPlanContent(): Promise<string | null> {
        try {
            const script = PLANNING_SELECTORS.buildExtractPlanContentScript(this.baselineNotifyCount, this.baselineCardCount);
            const result = await this.runEvaluateScript(script);
            
            if (typeof result === 'string' && result.trim().length > 50) {
                return result;
            }

            // Fallback: if DOM extraction didn't yield enough content, try to read from disk
            const planTitle = this.lastDetectedInfo?.planTitle;
            if (planTitle) {
                logger.debug(`[PlanningDetector] DOM extraction returned empty/short result. Trying filesystem fallback for "${planTitle}"...`);
                const fsContent = await this.findLatestArtifactFile(planTitle);
                if (fsContent) {
                    return fsContent;
                }
            }

            return typeof result === 'string' ? result : null;
        } catch (error) {
            logger.error('[PlanningDetector] Error extracting plan content:', error);
            return null;
        }
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
     *   1. Get planning button info from DOM (with contextId)
     *   2. Notify via callback only on new detection (prevent duplicates)
     *   3. Reset lastDetectedKey / lastDetectedInfo when buttons disappear
     */
    private async poll(): Promise<void> {
        if (this.isPaused) return;
        try {
            // Expire click-guard state after 10 seconds
            if (this.lastClickedChip && Date.now() - this.lastClickedChip.at > 10000) {
                this.lastClickedChip = null;
            }

            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: PLANNING_SELECTORS.buildDetectPlanningScript(
                    this.lastClickedChip?.text || null,
                    Array.from(this.autoOpenedChips),
                    this.baselineNotifyCount,
                    this.baselineCardCount,
                    this.baselineIconCount,
                ),
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            
            // Expected shape: PlanningInfo | PlanningInfo+fileRefMode | { collapsed: true, chipText } | { autoOpened: true, chipText } | null
            const payload = result?.result?.value ?? null;
            
            if (payload && payload.collapsed) {
                // We just initiated an auto-click on a collapsed chip
                this.lastClickedChip = { text: payload.chipText, at: Date.now() };
                logger.debug(`[PlanningDetector] Auto-clicked collapsed artifact chip: "${payload.chipText}"`);
                return; // Wait for the next poll cycle to detect the expanded buttons
            }

            if (payload && payload.autoOpened) {
                // Read-only artifact (Walkthrough, Task) was auto-opened — send lightweight notification
                this.lastClickedChip = null;
                const chipText = payload.chipText;
                this.autoOpenedChips.add(chipText);
                logger.info(`[PlanningDetector] Auto-opened read-only artifact: "${chipText}"`);
                if (this.onAutoOpened) {
                    Promise.resolve(this.onAutoOpened(chipText)).catch((err) => {
                        logger.error('[PlanningDetector] onAutoOpened callback failed:', err);
                    });
                }
                return;
            }

            const info: PlanningInfo | null = payload;

            if (info) {
                // Clear click-guard state (successful expansion)
                this.lastClickedChip = null;
                
                // Duplicate prevention: use button text + content preview as key (stable across DOM redraws, unique per plan)
                const uniquePreview = `${info.planTitle}::${info.planSummary.slice(0, 50)}::${info.description.slice(0, 50)}`;
                const key = `${info.openText}::${info.proceedText}::${uniquePreview}`;
                const now = Date.now();
                const withinCooldown = (now - this.lastNotifiedAt) < PlanningDetector.COOLDOWN_MS;

                // Allow "upgrade" notifications: if the previous detection was fileRefMode or had no
                // proceedText, and the new detection has a real Proceed button, always re-notify —
                // this is a better version of the same plan and the user must be able to Proceed.
                const isUpgrade = !!(info.proceedText &&
                    this.lastDetectedInfo &&
                    (this.lastDetectedInfo.fileRefMode || !this.lastDetectedInfo.proceedText));

                if (key !== this.lastDetectedKey && (!withinCooldown || isUpgrade)) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastNotifiedAt = now;
                    Promise.resolve(this.onPlanningRequired(info)).catch((err) => {
                        logger.error('[PlanningDetector] onPlanningRequired callback failed:', err);
                    });
                } else if (key === this.lastDetectedKey) {
                    // Same key — update stored info silently
                    this.lastDetectedInfo = info;
                }

            } else {
                // Reset when buttons disappear (prepare for next planning detection)
                const wasDetected = this.lastDetectedKey !== null;
                this.lastDetectedKey = null;
                this.lastDetectedInfo = null;
                if (wasDetected && this.onResolved) {
                    this.onResolved();
                }
            }
        } catch (error) {
            // Ignore CDP errors and continue monitoring
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[PlanningDetector] Error during polling:', error);
        }
    }

    /** Internal click handler using buildClickScript from approvalDetector. */
    private async clickButton(buttonText: string): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(buildClickScript(buttonText));
            return result?.ok === true;
        } catch (error) {
            logger.error('[PlanningDetector] Error while clicking button:', error);
            return false;
        }
    }

    /** Execute Runtime.evaluate with contextId and return result.value. */
    private async runEvaluateScript(expression: string): Promise<any> {
        const contextId = this.cdpService.getPrimaryContextId();
        const callParams: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise: false,
        };
        if (contextId !== null) {
            callParams.contextId = contextId;
        }
        const result = await this.cdpService.call('Runtime.evaluate', callParams);
        return result?.result?.value;
    }
}
