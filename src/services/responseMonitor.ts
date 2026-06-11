import { logger } from '../utils/logger';
import type { ExtractionMode } from '../utils/config';
import { CdpService } from './cdpService';
import {
    classifyAssistantSegments,
} from './assistantDomExtractor';
import { RESPONSE_SELECTORS } from '../utils/domSelectors';

/** Response generation phases */
export type ResponsePhase = 'waiting' | 'thinking' | 'generating' | 'complete' | 'timeout' | 'quotaReached';

export interface ResponseMonitorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in ms (default: 2000) */
    pollIntervalMs?: number;
    /** Max monitoring duration in ms (default: 300000) */
    maxDurationMs?: number;
    /** Consecutive stop-gone confirmations needed (default: 3) */
    stopGoneConfirmCount?: number;
    /** Extraction mode: 'legacy' uses innerText, 'structured' uses DOM segment extraction */
    extractionMode?: ExtractionMode;
    /** Text update callback */
    onProgress?: (text: string) => void;
    /** Generation complete callback. Meta.source indicates whether text is already Telegram HTML (structured) or plain (legacy). */
    onComplete?: (finalText: string, meta?: { source: 'structured' | 'legacy'; choices?: string[] }) => void;
    /** Timeout callback */
    onTimeout?: (lastText: string) => void;
    /** Phase change callback */
    onPhaseChange?: (phase: ResponsePhase, text: string | null) => void;
    /** Process log update callback (activity messages + tool output) */
    onProcessLog?: (text: string) => void;
    /** Thinking content callback (AI thinking/reasoning text) */
    onThinkingLog?: (text: string) => void;
}

/**
 * Lean AI response monitor.
 *
 * Each poll makes exactly 3 CDP calls: stop button, quota, text extraction.
 * Completion: stop button gone N consecutive times -> complete.
 * Simple baseline suppression via string comparison.
 * NO network event subscription.
 */
export class ResponseMonitor {
    private readonly cdpService: CdpService;
    private readonly pollIntervalMs: number;
    private readonly maxDurationMs: number;
    private readonly stopGoneConfirmCount: number;
    private readonly extractionMode: ExtractionMode;
    private readonly onProgress?: (text: string) => void;
    private readonly onComplete?: (finalText: string, meta?: { source: 'structured' | 'legacy'; choices?: string[] }) => void;
    private readonly onTimeout?: (lastText: string) => void;
    private readonly onPhaseChange?: (phase: ResponsePhase, text: string | null) => void;
    private readonly onProcessLog?: (text: string) => void;
    private readonly onThinkingLog?: (text: string) => void;

    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private isRunning: boolean = false;
    private lastText: string | null = null;
    private baselineText: string | null = null;
    private generationStarted: boolean = false;
    private currentPhase: ResponsePhase = 'waiting';
    private stopGoneCount: number = 0;
    private quotaDetected: boolean = false;
    private seenProcessLogKeys: Set<string> = new Set();
    private seenThinkingLogKeys: Set<string> = new Set();
    private structuredDiagLogged: boolean = false;
    private lastExtractionSource: 'structured' | 'legacy' | null = null;
    /** Consecutive WebSocket error count — stops monitor after threshold */
    private consecutiveWsErrors: number = 0;

    /**
     * Baseline artifact counts captured at monitoring start.
     * Used to exclude old-session artifacts from planning-active detection.
     */
    private baselineNotifyCount: number = 0;
    private baselineCardCount: number = 0;

    constructor(options: ResponseMonitorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.maxDurationMs = options.maxDurationMs ?? 300000;
        this.stopGoneConfirmCount = options.stopGoneConfirmCount ?? 3;
        this.extractionMode = options.extractionMode
            ?? (process.env.EXTRACTION_MODE === 'legacy' ? 'legacy' : 'structured');
        this.onProgress = options.onProgress;
        this.onComplete = options.onComplete;
        this.onTimeout = options.onTimeout;
        this.onPhaseChange = options.onPhaseChange;
        this.onProcessLog = options.onProcessLog;
        this.onThinkingLog = options.onThinkingLog;
    }

    /**
     * Build the COMBINED_POLL script with current baseline counts injected.
     * Replaces __BASELINE_NOTIFY__ and __BASELINE_CARD__ placeholders with
     * the actual artifact counts captured at monitoring start.
     */
    private buildCombinedPollScript(): string {
        return RESPONSE_SELECTORS.COMBINED_POLL_TEMPLATE
            .replace('__BASELINE_NOTIFY__', String(this.baselineNotifyCount))
            .replace('__BASELINE_CARD__', String(this.baselineCardCount));
    }

    /** Start monitoring */
    async start(): Promise<void> {
        this.cdpService.emit('response-monitor:start');
        return this.initMonitoring(false);
    }

    /**
     * Start monitoring in passive mode.
     * Same as start() but with generationStarted=true, so text changes
     * are detected immediately without waiting for the stop button to appear.
     * Used when joining an existing session that may already be generating.
     */
    async startPassive(): Promise<void> {
        this.cdpService.emit('response-monitor:start');
        return this.initMonitoring(true);
    }

    /** Internal initialization shared between start() and startPassive() */
    private async initMonitoring(passive: boolean): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastText = null;
        this.baselineText = null;
        this.generationStarted = passive;
        this.currentPhase = passive ? 'generating' : 'waiting';
        this.stopGoneCount = 0;
        this.quotaDetected = false;
        this.seenProcessLogKeys = new Set();
        this.seenThinkingLogKeys = new Set();
        this.consecutiveWsErrors = 0;

        this.onPhaseChange?.(this.currentPhase, null);

        // Capture artifact baseline FIRST — count existing notify containers and cards
        // so the planning-active check in COMBINED_POLL can skip old-session artifacts
        try {
            const baselineResult = await this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(
                `(() => ({ notifyCount: document.querySelectorAll('.notify-user-container').length, cardCount: document.querySelectorAll('div[class*="border"][class*="rounded-lg"]').length }))()`
            ));
            const bl = baselineResult?.result?.value;
            if (bl) {
                this.baselineNotifyCount = bl.notifyCount ?? 0;
                this.baselineCardCount = bl.cardCount ?? 0;
            }
            logger.debug(`[ResponseMonitor] Artifact baseline: ${this.baselineNotifyCount} notify, ${this.baselineCardCount} cards`);
        } catch (e) {
            logger.debug('[ResponseMonitor] Artifact baseline failed (best-effort):', e);
        }

        // Capture baselines in parallel (text + process logs + optional structured)
        const baselinePromises: Promise<any>[] = [
            this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(RESPONSE_SELECTORS.RESPONSE_TEXT)).catch(() => null),
            this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(RESPONSE_SELECTORS.PROCESS_LOGS)).catch(() => null),
        ];
        if (this.extractionMode === 'structured') {
            baselinePromises.push(
                this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(RESPONSE_SELECTORS.RESPONSE_STRUCTURED)).catch(() => null),
            );
        }
        const [baseResult, logResult, structuredBaseline] = await Promise.all(baselinePromises);

        // Baseline text
        const rawValue = baseResult?.result?.value;
        this.baselineText = typeof rawValue === 'string' ? rawValue.trim() || null : null;

        // Baseline process log keys
        const logEntries = logResult?.result?.value;
        if (Array.isArray(logEntries)) {
            this.seenProcessLogKeys = new Set(
                logEntries
                    .map((s: string) => (s || '').replace(/\r/g, '').trim())
                    .filter((s: string) => s.length > 0)
                    .map((s: string) => s.slice(0, 200)),
            );
        }

        // Structured baseline activity lines
        if (structuredBaseline) {
            try {
                const baselineClassified = classifyAssistantSegments(structuredBaseline?.result?.value);
                if (baselineClassified.diagnostics.source === 'dom-structured') {
                    this.baselineText = baselineClassified.finalOutputText.trim() || null;
                    for (const line of baselineClassified.activityLines) {
                        const key = (line || '').replace(/\r/g, '').trim().slice(0, 200);
                        if (key) this.seenProcessLogKeys.add(key);
                    }
                    for (const line of baselineClassified.thinkingLines) {
                        const key = (line || '').replace(/\r/g, '').trim().slice(0, 200);
                        if (key) this.seenThinkingLogKeys.add(key);
                    }
                }
            } catch (e) {
                logger.debug('[ResponseMonitor] Structured baseline classification failed (best-effort):', e);
            }
        }

        // Set timeout timer
        if (this.maxDurationMs > 0) {
            this.timeoutTimer = setTimeout(async () => {
                // Guard: skip if already completed or quota-reached
                if (this.currentPhase === 'complete' || this.currentPhase === 'quotaReached') return;
                const lastText = this.lastText ?? '';
                this.setPhase('timeout', lastText);
                await this.stop();
                try {
                    await Promise.resolve(this.onTimeout?.(lastText));
                } catch (error) {
                    logger.error('[ResponseMonitor] timeout callback failed:', error);
                }
            }, this.maxDurationMs);
        }

        const mode = passive ? 'Passive monitoring' : 'Monitoring';
        logger.debug(
            `── ${mode} started | poll=${this.pollIntervalMs}ms timeout=${this.maxDurationMs / 1000}s baseline=${this.baselineText?.length ?? 0}ch`,
        );

        this.schedulePoll();
    }

    /** Stop monitoring */
    async stop(): Promise<void> {
        this.isRunning = false;
        this.cdpService.emit('response-monitor:stop');
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }

    /** Get current phase */
    getPhase(): ResponsePhase {
        return this.currentPhase;
    }

    /** Whether quota error was detected */
    getQuotaDetected(): boolean {
        return this.quotaDetected;
    }

    /** Whether monitoring is active */
    isActive(): boolean {
        return this.isRunning;
    }

    /** Get last extracted text */
    getLastText(): string | null {
        return this.lastText;
    }

    /** Get last extraction source (structured = HTML, legacy = plain text) */
    getLastExtractionSource(): 'structured' | 'legacy' | null {
        return this.lastExtractionSource;
    }

    /** Click the stop button to interrupt LLM generation */
    async clickStopButton(): Promise<{ ok: boolean; method?: string; error?: string }> {
        try {
            const result = await this.cdpService.call(
                'Runtime.evaluate',
                this.buildEvaluateParams(RESPONSE_SELECTORS.CLICK_STOP_BUTTON),
            );
            const value = result?.result?.value;

            if (this.isRunning) {
                await this.stop();
            }

            return value ?? { ok: false, error: 'CDP evaluation returned empty' };
        } catch (error: any) {
            return { ok: false, error: error.message || 'Failed to click stop button' };
        }
    }

    private setPhase(phase: ResponsePhase, text: string | null): void {
        if (this.currentPhase !== phase) {
            this.currentPhase = phase;
            const len = text?.length ?? 0;
            switch (phase) {
                case 'thinking':
                    logger.phase('Thinking');
                    break;
                case 'generating':
                    logger.phase(`Generating (${len} chars)`);
                    break;
                case 'complete':
                    logger.done(`Complete (${len} chars)`);
                    break;
                case 'timeout':
                    logger.warn(`Timeout (${len} chars captured)`);
                    break;
                case 'quotaReached':
                    logger.warn('Quota Reached');
                    break;
                default:
                    logger.phase(`${phase}`);
            }
            this.onPhaseChange?.(phase, text);
        }
    }

    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    private buildEvaluateParams(expression: string): Record<string, unknown> {
        const params: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise: true,
        };
        const contextId = this.cdpService.getPrimaryContextId?.();
        if (contextId !== null && contextId !== undefined) {
            params.contextId = contextId;
        }
        return params;
    }

    /**
     * Emit new process log entries, deduplicating against previously seen keys.
     */
    private emitNewProcessLogs(entries: string[]): void {
        for (const line of entries) {
            const normalized = (line || '').replace(/\r/g, '').trim();
            if (!normalized) continue;
            const key = normalized.slice(0, 200);
            if (this.seenProcessLogKeys.has(key)) continue;
            this.seenProcessLogKeys.add(key);
            try {
                this.onProcessLog?.(normalized.slice(0, 300));
            } catch (e) {
                logger.debug('[ResponseMonitor] onProcessLog callback error:', e);
            }
        }
    }

    /**
     * Emit new thinking log entries, deduplicating against previously seen keys.
     */
    private emitNewThinkingLogs(entries: string[]): void {
        for (const line of entries) {
            const normalized = (line || '').replace(/\r/g, '').trim();
            if (!normalized) continue;
            const key = normalized.slice(0, 200);
            if (this.seenThinkingLogKeys.has(key)) continue;
            this.seenThinkingLogKeys.add(key);
            // Also mark as seen in process logs to prevent cross-contamination
            this.seenProcessLogKeys.add(key);
            logger.debug('[ResponseMonitor] Emitting thinking entry:', normalized.slice(0, 80));
            try {
                this.onThinkingLog?.(normalized.slice(0, 2000));
            } catch (e) {
                logger.debug('[ResponseMonitor] onThinkingLog callback error:', e);
            }
        }
    }

    /**
     * Single poll cycle.
     * - Legacy mode: 4 CDP calls (stop, quota, text, process logs).
     * - Structured mode: 3-4 CDP calls (stop, quota, structured; legacy text on fallback).
     */
    private async poll(): Promise<void> {
        try {
            let isGenerating: boolean;
            let quotaDetected: boolean;
            let planningActive: boolean;
            let approvalActive = false;
            let currentText: string | null = null;
            let structuredHandledLogs = false;

            if (this.extractionMode === 'structured') {
                // Structured mode: run combined (stop+quota+planning) in parallel with structured extraction
                const [combinedResult, structuredResult] = await Promise.all([
                    this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(this.buildCombinedPollScript())),
                    this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(RESPONSE_SELECTORS.RESPONSE_STRUCTURED)).catch(() => null),
                ]);

                const combined = combinedResult?.result?.value ?? {};
                isGenerating = !!combined.isGenerating;
                quotaDetected = !!combined.quotaError;
                planningActive = !!combined.planningActive;
                approvalActive = !!combined.approvalActive;

                // Try structured extraction first
                if (structuredResult) {
                    try {
                        const payload = structuredResult?.result?.value;
                        const classified = classifyAssistantSegments(payload);

                        if (classified.diagnostics.source === 'dom-structured') {
                            currentText = classified.finalOutputText.trim() || null;
                            this.lastExtractionSource = 'structured';
                            structuredHandledLogs = true;

                            if (!this.structuredDiagLogged) {
                                this.structuredDiagLogged = true;
                                logger.debug('[ResponseMonitor] Structured extraction OK — segments:', classified.diagnostics.segmentCounts);
                            }

                            if (classified.activityLines.length > 0) {
                                this.emitNewProcessLogs(classified.activityLines);
                            }
                            if (classified.thinkingLines.length > 0) {
                                logger.debug('[ResponseMonitor] Thinking lines found:', classified.thinkingLines.length,
                                    'previews:', classified.thinkingLines.map(l => l.slice(0, 80)));
                                this.emitNewThinkingLogs(classified.thinkingLines);
                            }
                        } else if (!this.structuredDiagLogged) {
                            this.structuredDiagLogged = true;
                            logger.warn(
                                '[ResponseMonitor:poll] Structured extraction failed — reason:',
                                classified.diagnostics.fallbackReason ?? 'unknown',
                                '| payload type:', typeof payload,
                                '| payload:', payload === null ? 'null' : payload === undefined ? 'undefined' : 'object',
                            );
                        }
                    } catch (error) {
                        logger.warn('[ResponseMonitor:poll] RESPONSE_STRUCTURED classification failed:', error);
                    }
                }

                // Fallback to legacy text from combined result
                if (currentText === null) {
                    currentText = typeof combined.responseText === 'string' ? combined.responseText.trim() || null : null;
                    this.lastExtractionSource = 'legacy';
                }

                // Process logs from combined result
                if (!structuredHandledLogs && Array.isArray(combined.processLogs)) {
                    this.emitNewProcessLogs(combined.processLogs);
                }
            } else {
                // Legacy mode: single combined CDP call gets everything
                const combinedResult = await this.cdpService.call(
                    'Runtime.evaluate',
                    this.buildEvaluateParams(this.buildCombinedPollScript()),
                );
                const combined = combinedResult?.result?.value ?? {};
                isGenerating = !!combined.isGenerating;
                quotaDetected = !!combined.quotaError;
                planningActive = !!combined.planningActive;
                approvalActive = !!combined.approvalActive;
                currentText = typeof combined.responseText === 'string' ? combined.responseText.trim() || null : null;
                this.lastExtractionSource = 'legacy';

                if (Array.isArray(combined.processLogs)) {
                    this.emitNewProcessLogs(combined.processLogs);
                }
            }

            // CDP calls succeeded — reset WebSocket error counter
            this.consecutiveWsErrors = 0;

            // Handle stop button appearing
            if (isGenerating) {
                if (!this.generationStarted) {
                    this.generationStarted = true;
                    this.setPhase('thinking', null);
                }
                this.stopGoneCount = 0;
            }

            // Handle quota detection
            if (quotaDetected) {
                const hasText = !!(this.lastText && this.lastText.trim().length > 0);
                logger.warn(`[ResponseMonitor] quota detected hasText=${hasText}`);
                if (hasText) {
                    this.quotaDetected = true;
                } else {
                    this.setPhase('quotaReached', '');
                    await this.stop();
                    try {
                        await Promise.resolve(this.onComplete?.('', { source: 'legacy' }));
                    } catch (error) {
                        logger.error('[ResponseMonitor] complete callback failed:', error);
                    }
                    return;
                }
            }

            // Baseline suppression: do not emit progress for pre-existing text.
            // IMPORTANT: do not early-return here; completion logic must still run.
            const effectiveText = (
                currentText !== null &&
                this.baselineText !== null &&
                currentText === this.baselineText &&
                this.lastText === null
            ) ? null : currentText;

            // Text change handling
            const textChanged = effectiveText !== null && effectiveText !== this.lastText;
            if (textChanged) {
                this.lastText = effectiveText;

                if (this.currentPhase === 'waiting' || this.currentPhase === 'thinking') {
                    this.setPhase('generating', effectiveText);
                    if (!this.generationStarted) {
                        this.generationStarted = true;
                    }
                }

                this.onProgress?.(effectiveText);
            }

            // Completion: stop button gone N consecutive times
            if (!isGenerating && this.generationStarted) {
                // Planning check already done in combined poll script
                if (planningActive || approvalActive) {
                    this.stopGoneCount = 0;
                    logger.info(`[ResponseMonitor] ${planningActive ? 'Planning' : 'Approval'} dialog active — deferring completion`);
                } else {
                    this.stopGoneCount++;
                    if (this.stopGoneCount >= this.stopGoneConfirmCount && this.isRunning) {
                        const finalText = this.lastText ?? '';
                        this.setPhase('complete', finalText);
                        await this.stop();
                        try {
                            const source = this.lastExtractionSource ?? 'legacy';
                            
                            // Scan for choices/quick replies
                            const choicesResult = await this.cdpService.call('Runtime.evaluate', this.buildEvaluateParams(RESPONSE_SELECTORS.CHOICES)).catch(() => null);
                            const choices = choicesResult?.result?.value ?? undefined;
                            if (choices && Array.isArray(choices) && choices.length > 0) {
                                logger.info(`[ResponseMonitor] Choices detected: ${choices.join(', ')}`);
                            }

                            await Promise.resolve(this.onComplete?.(finalText, { source, choices }));
                        } catch (error) {
                            logger.error('[ResponseMonitor] complete callback failed:', error);
                        }
                        return;
                    }
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('WebSocket is not connected') || msg.includes('WebSocket disconnected')) {
                this.consecutiveWsErrors++;
                if (this.consecutiveWsErrors >= 5) {
                    logger.error(`[ResponseMonitor] ${this.consecutiveWsErrors} consecutive WebSocket errors — stopping monitor`);
                    const lastText = this.lastText ?? '';
                    await this.stop();
                    try {
                        await Promise.resolve(this.onTimeout?.(lastText));
                    } catch (e) { logger.debug('[ResponseMonitor] onTimeout callback error:', e); }
                }
                return;
            }
            logger.error('[ResponseMonitor] poll error:', error);
        }
    }
}
