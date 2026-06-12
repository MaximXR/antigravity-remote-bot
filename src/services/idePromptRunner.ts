import { logger } from '../utils/logger';
import { CdpService, ExtractedResponseImage } from './cdpService';
import { ResponseMonitor, PreCapturedBaselines } from './responseMonitor';
import { PlanningDetector } from './planningDetector';
import { classifyAssistantSegments, extractAssistantSegmentsPayloadScript } from './assistantDomExtractor';
import { splitOutputAndLogs } from '../utils/telegramFormatter';
import { t } from '../utils/i18n';

export interface IdePromptCallbacks {
    onActivityProgress?: (data: {
        title: string;
        body: string;
        footer: string;
        isFinalized: boolean;
    }) => Promise<void>;
    onLiveResponseUpdate?: (data: {
        title: string;
        body: string;
        footer: string;
        isAlreadyHtml: boolean;
        isFinalized: boolean;
    }) => Promise<void>;
    onComplete?: (data: {
        finalText: string;
        isHtml: boolean;
        choices: string[];
        elapsedSeconds: number;
        generatedImages: ExtractedResponseImage[];
    }) => Promise<void>;
    onQuotaReached?: (data: {
        elapsedSeconds: number;
        modelLabel: string;
        progressBody: string;
    }) => Promise<void>;
    onTimeout?: (data: {
        elapsedSeconds: number;
        payloadText: string;
        isHtml: boolean;
    }) => Promise<void>;
    onError?: (errorMsg: string) => Promise<void>;
}

export interface IdePromptOptions {
    modelLabel: string;
    modeName: string;
    isStopRequested: () => boolean;
    clearStopRequest: () => void;
    planningDetector?: PlanningDetector;
    maxOutboundImages?: number;
    ideLabel?: string; // used for mirror mode labeling
}

export class IdePromptRunner {
    private static readonly MAX_PROGRESS_BODY = 3500;
    private static readonly MAX_PROGRESS_ENTRIES = 60;
    private static readonly LIVE_RESPONSE_MAX_LEN = 3800;

    /**
     * Injects a prompt into the IDE via CDP and monitors the response.
     */
    static async runPrompt(
        cdp: CdpService,
        prompt: string,
        inboundImagePaths: string[],
        options: IdePromptOptions,
        callbacks: IdePromptCallbacks
    ): Promise<void> {
        if (!cdp.isConnected()) {
            if (callbacks.onError) {
                await callbacks.onError('Not connected to Antigravity.');
            }
            return;
        }

        try {
            // Reset PlanningDetector baseline if provided
            if (options.planningDetector) {
                await options.planningDetector.resetBaseline().catch((err: Error) =>
                    logger.error('[IdePromptRunner] PlanningDetector baseline reset failed:', err)
                );
            }

            // Capture baseline BEFORE injecting the message to avoid race conditions with fast models
            const extractionMode = process.env.EXTRACTION_MODE === 'legacy' ? 'legacy' : 'structured';
            const preCapturedBaselines = await ResponseMonitor.captureBaselines(cdp, extractionMode).catch((err) => {
                logger.error('[IdePromptRunner] Failed to capture baselines before inject:', err);
                return undefined;
            });

            // Inject message
            let injectResult;
            if (inboundImagePaths.length > 0) {
                injectResult = await cdp.injectMessageWithImageFiles(prompt, inboundImagePaths);
            } else {
                injectResult = await cdp.injectMessage(prompt);
            }

            if (!injectResult.ok) {
                if (callbacks.onError) {
                    await callbacks.onError(`Failed to inject message: ${injectResult.error}`);
                }
                return;
            }

            await this.monitorResponseInternal(cdp, prompt, options, callbacks, false, preCapturedBaselines);
        } catch (e: any) {
            logger.error('[IdePromptRunner] runPrompt failed:', e);
            if (callbacks.onError) {
                await callbacks.onError(e.message || String(e));
            }
        }
    }

    /**
     * Monitors an already active response in the IDE (for mirroring).
     */
    static async monitorResponse(
        cdp: CdpService,
        userPrompt: string,
        options: IdePromptOptions,
        callbacks: IdePromptCallbacks
    ): Promise<void> {
        if (!cdp.isConnected()) {
            if (callbacks.onError) {
                await callbacks.onError('Not connected to Antigravity.');
            }
            return;
        }

        try {
            await this.monitorResponseInternal(cdp, userPrompt, options, callbacks, true, undefined);
        } catch (e: any) {
            logger.error('[IdePromptRunner] monitorResponse failed:', e);
            if (callbacks.onError) {
                await callbacks.onError(e.message || String(e));
            }
        }
    }

    private static async monitorResponseInternal(
        cdp: CdpService,
        userPrompt: string,
        options: IdePromptOptions,
        callbacks: IdePromptCallbacks,
        isMirrorMode: boolean,
        preCapturedBaselines?: PreCapturedBaselines
    ): Promise<void> {
        const startTime = Date.now();
        const modelLabel = options.modelLabel;
        const modeName = options.modeName;
        const maxOutboundImages = options.maxOutboundImages ?? 4;
        const ideLabel = options.ideLabel ?? 'IDE';

        const progressTitle = () => {
            if (isMirrorMode) {
                return `🧠 [${ideLabel}] · ${modelLabel}`;
            }
            return `${modeName} · ${modelLabel}`;
        };
        const progressFooter = () => `⏱️ ${Math.round((Date.now() - startTime) / 1000)}s`;

        let isFinalized = false;
        let elapsedTimer: ReturnType<typeof setInterval> | null = null;
        let lastProgressText = '';
        let monitorDoneResolve!: () => void;
        const monitorDone = new Promise<void>(resolve => { monitorDoneResolve = resolve; });

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
            // Escape HTML characters before passing back
            return collapsed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 120);
        };

        const trimProgressLog = (): void => {
            while (progressLog.length > this.MAX_PROGRESS_ENTRIES) progressLog.shift();
        };

        const buildProgressBody = (): string => {
            const lines: string[] = [];
            for (const e of progressLog) {
                switch (e.kind) {
                    case 'thought':
                        lines.push(`💭 <i>${e.text}</i>`);
                        break;
                    case 'thought-content':
                        lines.push(`<i>${e.text}</i>`);
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
            if (body.length > this.MAX_PROGRESS_BODY) {
                body = '...\n\n' + body.slice(-this.MAX_PROGRESS_BODY + 5);
            }
            return body || '<i>Generating...</i>';
        };

        const triggerProgressRefresh = async (finalized = false): Promise<void> => {
            if (callbacks.onActivityProgress) {
                await callbacks.onActivityProgress({
                    title: progressTitle(),
                    body: buildProgressBody(),
                    footer: progressFooter(),
                    isFinalized: finalized
                });
            }
        };

        // Notify initial progress
        await triggerProgressRefresh(false);

        const monitor = new ResponseMonitor({
            cdpService: cdp,
            pollIntervalMs: 2000,
            maxDurationMs: 1800000,
            stopGoneConfirmCount: 5,
            preCapturedBaselines,
            onPhaseChange: () => {},
            onProcessLog: (logText) => {
                if (isFinalized) return;
                const trimmed = (logText || '').trim();
                if (!trimmed || isJunkEntry(trimmed)) return;
                const formatted = formatActivityLine(trimmed);
                if (formatted) {
                    progressLog.push({ kind: 'activity', text: formatted });
                    trimProgressLog();
                    triggerProgressRefresh(false).catch(() => {});
                }
            },
            onThinkingLog: (thinkingText) => {
                if (isFinalized) return;
                const trimmed = (thinkingText || '').trim();
                if (!trimmed) return;
                
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
                triggerProgressRefresh(false).catch(() => {});
            },
            onProgress: (text) => {
                if (isFinalized) return;
                const isStructured = monitor.getLastExtractionSource() === 'structured';
                const separated = isStructured ? { output: text, logs: '' } : splitOutputAndLogs(text);
                if (separated.output && separated.output.trim().length > 0) {
                    lastProgressText = separated.output;
                    if (callbacks.onLiveResponseUpdate) {
                        callbacks.onLiveResponseUpdate({
                            title: progressTitle(),
                            body: lastProgressText,
                            footer: progressFooter(),
                            isAlreadyHtml: isStructured,
                            isFinalized: false
                        }).catch(() => {});
                    }
                }
            },
            onComplete: async (finalText, meta) => {
                if (isFinalized) return;
                isFinalized = true;
                if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }

                const wasStoppedByUser = options.isStopRequested();
                if (wasStoppedByUser) {
                    options.clearStopRequest();
                    monitorDoneResolve();
                    return;
                }

                try {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const isQuotaError = monitor.getPhase() === 'quotaReached' || monitor.getQuotaDetected();

                    if (isQuotaError) {
                        if (callbacks.onQuotaReached) {
                            await callbacks.onQuotaReached({
                                elapsedSeconds: elapsed,
                                modelLabel,
                                progressBody: buildProgressBody()
                            });
                        }
                        monitorDoneResolve();
                        return;
                    }

                    // Fresh extraction
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
                    } catch (e) {
                        logger.debug('[IdePromptRunner] Fresh structured extraction failed:', e);
                    }

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
                        finalResponseText = await this.tryEmergencyExtractText(cdp);
                        isAlreadyHtml = false;
                    }

                    const separated = isAlreadyHtml ? { output: finalResponseText, logs: '' } : splitOutputAndLogs(finalResponseText);
                    const finalOutputText = separated.output || finalResponseText;

                    // Extract thinking block
                    let thinkMsgText = '';
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
                                    sections.push(`  💭 <b>${label.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>\n\n<i>${body.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</i>`);
                                } else {
                                    sections.push(`  💭 <b>${label.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>`);
                                }
                            }
                            thinkMsgText = `<blockquote expandable>${sections.join('\n\n')}</blockquote>`;
                        }
                    } catch (e) {
                        logger.error('[IdePromptRunner] Failed to extract thinking block:', e);
                    }

                    // Extract generated images
                    let generatedImages: ExtractedResponseImage[] = [];
                    try {
                        generatedImages = await cdp.extractLatestResponseImages(maxOutboundImages);
                    } catch (e) {
                        logger.error('[IdePromptRunner] Failed to extract generated images:', e);
                    }

                    // Notify finalized activity
                    thinkingActive = false;
                    await triggerProgressRefresh(true);

                    // Call final complete callback
                    if (callbacks.onComplete) {
                        await callbacks.onComplete({
                            finalText: finalOutputText,
                            isHtml: isAlreadyHtml,
                            choices: meta?.choices || [],
                            elapsedSeconds: elapsed,
                            generatedImages
                        });
                        // If we have a thinking block, pass it back or notify it
                        if (thinkMsgText && callbacks.onLiveResponseUpdate) {
                            // Show the thinking block right before the final response
                            // By wrapping it in a live response update or a specific call.
                            // We can let the bot index.ts handle this.
                        }
                    }
                } catch (error: any) {
                    logger.error('[IdePromptRunner] onComplete callback failed:', error);
                    if (callbacks.onError) {
                        await callbacks.onError(error.message || String(error));
                    }
                } finally {
                    monitorDoneResolve();
                }
            },
            onTimeout: async (lastText) => {
                if (isFinalized) return;
                isFinalized = true;
                if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                options.clearStopRequest();

                try {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const timeoutText = (lastText && lastText.trim().length > 0) ? lastText : lastProgressText;
                    const timeoutIsHtml = monitor.getLastExtractionSource() === 'structured';
                    const separated = timeoutIsHtml ? { output: timeoutText || '', logs: '' } : splitOutputAndLogs(timeoutText || '');
                    const payload = separated.output && separated.output.trim().length > 0
                        ? `${separated.output}\n\n[Monitor Ended] Timeout after 30 minutes.`
                        : 'Monitor ended after 30 minutes. No text was retrieved.';

                    if (callbacks.onTimeout) {
                        await callbacks.onTimeout({
                            elapsedSeconds: elapsed,
                            payloadText: payload,
                            isHtml: timeoutIsHtml
                        });
                    }
                } catch (error: any) {
                    logger.error('[IdePromptRunner] onTimeout callback failed:', error);
                } finally {
                    monitorDoneResolve();
                }
            }
        });

        await monitor.start();

        elapsedTimer = setInterval(() => {
            if (isFinalized) { clearInterval(elapsedTimer!); return; }
            triggerProgressRefresh(false).catch(() => {});
        }, 5000);

        await monitorDone;
    }

    private static async tryEmergencyExtractText(cdp: CdpService): Promise<string> {
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
        } catch (e) {
            logger.debug('[IdePromptRunner:tryEmergencyExtractText] Failed:', e);
            return '';
        }
    }
}
