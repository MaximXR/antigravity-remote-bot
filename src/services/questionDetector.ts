import { logger } from '../utils/logger';
import { QUESTION_SELECTORS } from '../utils/domSelectors';
import { CdpService } from './cdpService';

/** Interactive question information */
export interface QuestionInfo {
    /** The question text */
    question: string;
    /** The choices available */
    options: string[];
    /** Whether multi-select is enabled */
    isMultiSelect: boolean;
    /** Unique key for deduplication */
    key: string;
}

export interface QuestionDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when a question is detected */
    onQuestionRequired: (info: QuestionInfo) => void;
    /** Callback when a previously detected question is resolved (disappeared) */
    onResolved?: () => void;
}

/**
 * Detects interactive question forms in the Antigravity UI via polling.
 */
export class QuestionDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onQuestionRequired: (info: QuestionInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    private isPaused: boolean = false;
    private lastDetectedKey: string | null = null;
    private lastDetectedInfo: QuestionInfo | null = null;
    private lastNotifiedAt: number = 0;
    private consecutiveNullsCount: number = 0;
    private static readonly COOLDOWN_MS = 5000;

    constructor(options: QuestionDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onQuestionRequired = options.onQuestionRequired;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
        this.consecutiveNullsCount = 0;
        this.schedulePoll();
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Return the last detected question info. */
    getLastDetectedInfo(): QuestionInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is active. */
    isActive(): boolean {
        return this.isRunning;
    }

    pause(): void {
        this.isPaused = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    resume(): void {
        this.isPaused = false;
        if (this.isRunning) {
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            this.poll().then(() => {
                this.schedulePoll();
            }).catch(err => {
                logger.error('[QuestionDetector] Error in resume poll:', err);
                this.schedulePoll();
            });
        }
    }

    /** Click an option by index */
    async clickOption(optionIndex: number): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(QUESTION_SELECTORS.buildClickQuestionOptionScript(optionIndex));
            return result?.ok === true;
        } catch (error) {
            logger.error('[QuestionDetector] Error clicking option:', error);
            return false;
        }
    }

    /** Type custom text and submit */
    async submitTextAnswer(optionIndex: number, text: string): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(QUESTION_SELECTORS.buildSubmitQuestionTextScript(optionIndex, text));
            return result?.ok === true;
        } catch (error) {
            logger.error('[QuestionDetector] Error submitting text answer:', error);
            return false;
        }
    }

    /** Click Submit button directly */
    async clickSubmit(): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(QUESTION_SELECTORS.SUBMIT_QUESTION_SCRIPT);
            return result?.ok === true;
        } catch (error) {
            logger.error('[QuestionDetector] Error clicking submit:', error);
            return false;
        }
    }

    /** Click Skip button directly */
    async clickSkip(): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(QUESTION_SELECTORS.SKIP_QUESTION_SCRIPT);
            return result?.ok === true;
        } catch (error) {
            logger.error('[QuestionDetector] Error clicking skip:', error);
            return false;
        }
    }

    /** Schedule the next poll. */
    private schedulePoll(): void {
        if (!this.isRunning || this.isPaused) return;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        this.pollTimer = setTimeout(async () => {
            if (!this.isRunning || this.isPaused) return;
            await this.poll();
            this.schedulePoll();
        }, this.pollIntervalMs);
    }

    /** Single poll iteration */
    private async poll(): Promise<void> {
        if (this.isPaused) return;
        try {
            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: QUESTION_SELECTORS.DETECT_QUESTION_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            const info: QuestionInfo | null = result?.result?.value ?? null;

            if (info) {
                this.consecutiveNullsCount = 0;
                const key = info.key;
                const now = Date.now();
                const withinCooldown = (now - this.lastNotifiedAt) < QuestionDetector.COOLDOWN_MS;

                if (key !== this.lastDetectedKey && !withinCooldown) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastNotifiedAt = now;
                    Promise.resolve(this.onQuestionRequired(info)).catch((err) => {
                        logger.error('[QuestionDetector] onQuestionRequired callback failed:', err);
                    });
                } else if (key === this.lastDetectedKey) {
                    this.lastDetectedInfo = info;
                }
            } else {
                this.consecutiveNullsCount++;
                if (this.consecutiveNullsCount >= 2) {
                    const wasDetected = this.lastDetectedKey !== null;
                    this.lastDetectedKey = null;
                    this.lastDetectedInfo = null;
                    this.consecutiveNullsCount = 0;
                    if (wasDetected && this.onResolved) {
                        this.onResolved();
                    }
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[QuestionDetector] Error during polling:', error);
        }
    }

    /** Execute Runtime.evaluate with contextId */
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
