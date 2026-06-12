import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { APPROVAL_SELECTORS, buildClickScript } from '../utils/domSelectors';

/** Approval button information */
export interface ApprovalInfo {
    /** Allow button text (e.g. "Allow") */
    approveText: string;
    /** Per-conversation allow button text (e.g. "Allow This Conversation") */
    alwaysAllowText?: string;
    /** Deny button text (e.g. "Deny") */
    denyText: string;
    /** Action description (e.g. "write to file.ts") */
    description: string;
    /** Whether LLM response generation is currently active */
    isGenerating?: boolean;
}

export type ApprovalType = 'file_edits' | 'console_commands' | 'read_access' | 'url_access' | 'other_requests';

export function classifyApproval(info: ApprovalInfo): ApprovalType {
    const desc = (info.description || '').toLowerCase();
    const approve = (info.approveText || '').toLowerCase();

    // 1. Console commands
    if (
        desc.includes('run command') ||
        desc.includes('run_command') ||
        desc.includes('execute command') ||
        desc.includes('execute terminal') ||
        desc.includes('terminal command') ||
        desc.includes('shell command') ||
        desc.includes('terminal') ||
        approve.includes('run') ||
        approve.includes('execute')
    ) {
        return 'console_commands';
    }

    // 2. File edits
    if (
        desc.includes('write_file') ||
        desc.includes('write file') ||
        desc.includes('write_to_file') ||
        desc.includes('edit file') ||
        desc.includes('modify file') ||
        desc.includes('create file') ||
        desc.includes('replace_file_content') ||
        desc.includes('multi_replace_file_content') ||
        desc.includes('replace content') ||
        desc.includes('save file') ||
        desc.includes('change file') ||
        desc.includes('write') ||
        desc.includes('edit') ||
        desc.includes('changes') ||
        desc.includes('file changes') ||
        desc.includes('files changes') ||
        desc.includes('file with changes') ||
        desc.includes('files with changes') ||
        /files? (?:with )?changes/i.test(desc)
    ) {
        return 'file_edits';
    }

    // 3. URL/Web access
    if (
        desc.includes('read_url') ||
        desc.includes('read url') ||
        desc.includes('fetch url') ||
        desc.includes('web request') ||
        desc.includes('search_web') ||
        desc.includes('search web') ||
        desc.includes('access url') ||
        desc.includes('http request') ||
        desc.includes('fetch website') ||
        desc.includes('url') ||
        desc.includes('http') ||
        desc.includes('website')
    ) {
        return 'url_access';
    }

    // 4. Read access
    if (
        desc.includes('read_file') ||
        desc.includes('read file') ||
        desc.includes('view_file') ||
        desc.includes('view file') ||
        desc.includes('list_dir') ||
        desc.includes('list directory') ||
        desc.includes('read directory') ||
        desc.includes('list contents') ||
        desc.includes('read_browser_page') ||
        desc.includes('read browser page') ||
        desc.includes('read') ||
        desc.includes('view')
    ) {
        return 'read_access';
    }

    return 'other_requests';
}

export interface ApprovalDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 1500ms) */
    pollIntervalMs?: number;
    /** Callback when an approval button is detected */
    onApprovalRequired: (info: ApprovalInfo) => void;
    /** Callback when a previously detected approval is resolved (buttons disappeared) */
    onResolved?: () => void;
}

/**
}

/**
 * Class that detects approval buttons in the Antigravity UI via polling.
 *
 * Notifies detected button info through the onApprovalRequired callback,
 * and performs the actual click operations via approveButton() / denyButton() methods.
 */
export class ApprovalDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onApprovalRequired: (info: ApprovalInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected button info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ApprovalInfo from the last detection (used for clicking) */
    private lastDetectedInfo: ApprovalInfo | null = null;
    /** Counter of consecutive polls returning null (used for resolution debouncing) */
    private consecutiveNullsCount: number = 0;

    constructor(options: ApprovalDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 1500;
        this.onApprovalRequired = options.onApprovalRequired;
        this.onResolved = options.onResolved;
    }

    /**
     * Start monitoring.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.consecutiveNullsCount = 0;
        this.schedulePoll();
    }

    /**
     * Stop monitoring.
     */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * Return the last detected approval button info.
     * Returns null if nothing has been detected.
     */
    getLastDetectedInfo(): ApprovalInfo | null {
        return this.lastDetectedInfo;
    }

    /** Schedule the next poll */
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
     *   1. Get approval button info from DOM (with contextId)
     *   2. Notify via callback only on new detection (prevent duplicates)
     *   3. Reset lastDetectedKey / lastDetectedInfo when buttons disappear
     */
    private async poll(): Promise<void> {
        try {
            const contextId = this.cdpService.getPrimaryContextId();
            logger.debug(`[ApprovalDetector:${this.cdpService.getCurrentWorkspaceName()}] Polling contextId=${contextId}`);
            const callParams: Record<string, unknown> = {
                expression: APPROVAL_SELECTORS.DETECT_APPROVAL_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            logger.debug(`[ApprovalDetector:${this.cdpService.getCurrentWorkspaceName()}] Raw evaluate result: ${JSON.stringify(result)}`);
            const info: ApprovalInfo | null = result?.result?.value ?? null;

            if (result?.result?.description || result?.exceptionDetails) {
                logger.warn(`[ApprovalDetector] Evaluation warning or exception:`, result.result?.description || result.exceptionDetails);
            }

            if (info) {
                this.consecutiveNullsCount = 0;
                // Duplicate prevention: use approveText + description combination as key
                const key = `${info.approveText}::${info.description}`;
                logger.debug(`[ApprovalDetector:${this.cdpService.getCurrentWorkspaceName()}] Detected info, key=${key}, lastKey=${this.lastDetectedKey}`);
                if (key !== this.lastDetectedKey) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    Promise.resolve(this.onApprovalRequired(info)).catch((err) => {
                        logger.error('[ApprovalDetector] onApprovalRequired callback failed:', err);
                    });
                }
            } else {
                this.consecutiveNullsCount++;
                if (this.consecutiveNullsCount >= 3) {
                    // Reset when buttons disappear (prepare for next approval detection)
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
            // Ignore CDP errors and continue monitoring
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[ApprovalDetector] Error during polling:', error);
        }
    }

    /**
     * Perform a single query to detect if an approval dialog is currently open.
     */
    async checkOnce(): Promise<ApprovalInfo | null> {
        try {
            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: APPROVAL_SELECTORS.DETECT_APPROVAL_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }
            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            return result?.result?.value ?? null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Click the approve button with the specified text via CDP.
     * @param buttonText Text of the button to click (default: detected approveText or "Allow")
     * @returns true if click succeeded
     */
    async approveButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.approveText ?? 'Allow';
        return this.clickButton(text);
    }

    /**
     * Select "Allow This Conversation / Always Allow".
     * If the button is not directly visible, expand the Allow Once dropdown and select it.
     */
    async alwaysAllowButton(): Promise<boolean> {
        const directCandidates = [
            this.lastDetectedInfo?.alwaysAllowText,
            'Allow This Conversation',
            'Allow This Chat',
            'この会話を許可',
            'Always Allow',
            '常に許可',
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

        for (const candidate of directCandidates) {
            if (await this.clickButton(candidate)) return true;
        }

        const expanded = await this.runEvaluateScript(APPROVAL_SELECTORS.EXPAND_ALWAYS_ALLOW_MENU_SCRIPT);
        if (expanded?.ok !== true) {
            return false;
        }

        for (let i = 0; i < 5; i++) {
            for (const candidate of directCandidates) {
                if (await this.clickButton(candidate)) return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        return false;
    }

    /**
     * Click the deny button with the specified text via CDP.
     * @param buttonText Text of the button to click (default: detected denyText or "Deny")
     * @returns true if click succeeded
     */
    async denyButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.denyText ?? 'Deny';
        return this.clickButton(text);
    }

    /**
     * Internal click handler (shared implementation for approveButton / denyButton).
     * Specifies contextId to click in the correct execution context.
     */
    private async clickButton(buttonText: string): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(buildClickScript(buttonText));
            return result?.ok === true;
        } catch (error) {
            logger.error('[ApprovalDetector] Error while clicking button:', error);
            return false;
        }
    }

    /**
     * Execute Runtime.evaluate with contextId and return result.value.
     */
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

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }
}
