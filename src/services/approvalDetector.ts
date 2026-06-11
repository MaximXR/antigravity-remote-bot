import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

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
        approve.includes('execute') ||
        approve.includes('выполнить') ||
        approve.includes('запустить')
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
        /files? (?:with )?changes/i.test(desc) ||
        desc.includes('изменить файл') ||
        desc.includes('записать файл') ||
        desc.includes('создать файл') ||
        approve.includes('принять') ||
        approve.includes('одобрить')
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
        desc.includes('view') ||
        desc.includes('прочитать') ||
        desc.includes('посмотреть')
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
 * Approval button detection script for the Antigravity UI
 *
 * Detects allow/deny button pairs and extracts descriptions with fallbacks.
 */
const DETECT_APPROVAL_SCRIPT = `(() => {
    const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', 'allow this time', '今回のみ許可', '1回のみ許可', '一度許可', 'разрешить один раз', 'разрешить раз', 'однократно'];
    const ALWAYS_ALLOW_PATTERNS = [
        'allow this conversation',
        'allow this chat',
        'always allow',
        '常に許可',
        'この会話を許可',
        'разрешить для этой беседы',
        'разрешить для этого чата',
        'разрешать всегда',
        'всегда разрешать',
    ];
    const ALLOW_PATTERNS = ['allow', 'permit', 'run', 'execute', 'accept', 'approve', '許可', '承認', '確認', '実行', 'разрешить', 'принять', 'выполнить', 'одобрить'];
    const DENY_PATTERNS = ['deny', 'reject', 'no', 'no (tell', '拒否', 'decline', '却下', 'отклонить', 'запретить', 'нет'];

    const normalize = (text) => (text || '').toLowerCase().replace(/\\\\s+/g, ' ').trim();
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const matchPattern = (text, pattern) => {
        if (!text || !pattern) return false;
        if (/^[a-z]+$/i.test(pattern)) {
            if (pattern.length <= 4) {
                const regex = new RegExp('\\\\b' + pattern + '\\\\b', 'i');
                return regex.test(text);
            }
        }
        return text.includes(pattern);
    };

    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;

    // --- Strategy 1: Look for selection-based dialog (has list of options and a Submit button) ---
    const submitBtn = Array.from(scope.querySelectorAll('button')).find(btn => {
        if (!isVisible(btn)) return false;
        const t = normalize(btn.textContent || '');
        return t === 'submit' || t.startsWith('submit');
    });

    if (submitBtn) {
        const container = submitBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-2xl"], div[class*="rounded-lg"], div[class*="border"]') || scope;
        const options = Array.from(container.querySelectorAll('label, button, [role="button"], .cursor-pointer'))
            .filter(el => {
                if (!isVisible(el)) return false;
                const text = (el.textContent || '').trim();
                return text.length > 0 && text.length < 80;
            });

        const allowOnceOpt = options.find(el => {
            const t = normalize(el.textContent || '');
            return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
        });

        const alwaysOpt = options.find(el => {
            const t = normalize(el.textContent || '');
            return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
        });

        const denyOpt = options.find(el => {
            const t = normalize(el.textContent || '');
            return DENY_PATTERNS.some(p => {
                if (p === 'no' && t.includes('no (tell')) return true;
                return t === p || matchPattern(t, p);
            });
        });

        if (allowOnceOpt && denyOpt) {
            let description = '';
            const headerEl = container.querySelector('span.text-sm.font-medium.text-foreground, h3, h2, p, .text-sm.font-medium');
            if (headerEl) {
                description = (headerEl.textContent || '').trim();
            }

            const additionalTexts = [];
            const infoElements = Array.from(container.querySelectorAll('div, span, p, code'));
            for (const el of infoElements) {
                if (el.children.length === 0) {
                    const text = (el.textContent || '').trim();
                    if (text && text.length > 2 && text.length < 200) {
                        const isOptionOrSubmit = options.some(opt => opt.contains(el)) || submitBtn.contains(el);
                        if (!isOptionOrSubmit && text !== description && !additionalTexts.includes(text)) {
                            if (!/^(yes|no|submit|cancel|ok|allow|deny|\\\\d+)$/i.test(text)) {
                                additionalTexts.push(text);
                            }
                        }
                    }
                }
            }
            if (additionalTexts.length > 0) {
                if (description) {
                    description += ' - ' + additionalTexts.join(' - ');
                } else {
                    description = additionalTexts.join(' - ');
                }
            }
            if (!description) description = 'Allow request';

            const approveText = (allowOnceOpt.textContent || '').trim();
            const alwaysAllowText = alwaysOpt ? (alwaysOpt.textContent || '').trim() : '';
            const denyText = (denyOpt.textContent || '').trim();

            let isGenerating = false;
            const stopEl = scope.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (stopEl) {
                isGenerating = true;
            } else {
                const stopPatterns = ['stop', 'stop generating', '停止', '生成を停止'];
                const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
                for (const btn of buttons) {
                    const t = (btn.textContent || '').trim().toLowerCase();
                    if (stopPatterns.some(p => t === p || t.includes(p))) {
                        isGenerating = true;
                        break;
                    }
                }
            }

            return { approveText, alwaysAllowText, denyText, description, isGenerating };
        }
    }

    // --- Strategy 2: Standard button-based confirmation dialog (original logic) ---
    const allClickables = Array.from(scope.querySelectorAll('button, [role="button"], a.monaco-button'))
        .filter(el => {
            const text = (el.textContent || '').trim();
            if (text.length === 0 || text.length > 50) return false;
            return isVisible(el);
        });

    const reversedClickables = [...allClickables].reverse();

    let approveBtn = reversedClickables.find(btn => {
        const t = normalize(btn.textContent || '');
        return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
    }) || null;

    if (!approveBtn) {
        approveBtn = reversedClickables.find(btn => {
            const t = normalize(btn.textContent || '');
            const isAlways = ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
            return !isAlways && ALLOW_PATTERNS.some(p => {
                if (p === 'accept' && t.includes('accept all')) return true;
                return t === p || matchPattern(t, p);
            });
        }) || null;
    }

    if (!approveBtn) return null;

    let container = approveBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-2xl"], div[class*="rounded-lg"], div[class*="border"]');
    if (!container) {
        let el = approveBtn.parentElement;
        for (let i = 0; i < 6 && el && el !== document.body; i++) {
            const clickables = Array.from(el.querySelectorAll('button, [role="button"], a.monaco-button')).filter(b => {
                const rect = b.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
            if (clickables.some(b => DENY_PATTERNS.some(p => normalize(b.textContent || '').includes(p)))) {
                container = el;
                break;
            }
            el = el.parentElement;
        }
    }
    if (!container) container = scope;

    const containerClickables = Array.from(container.querySelectorAll('button, [role="button"], a.monaco-button'))
        .filter(btn => {
            const rect = btn.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });

    const denyBtn = containerClickables.find(btn => {
        const t = normalize(btn.textContent || '');
        return DENY_PATTERNS.some(p => matchPattern(t, p));
    }) || null;

    if (!denyBtn) return null;

    const alwaysAllowBtn = containerClickables.find(btn => {
        const t = normalize(btn.textContent || '');
        return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
    }) || null;

    const approveText = (approveBtn.textContent || '').trim();
    const alwaysAllowText = alwaysAllowBtn ? (alwaysAllowBtn.textContent || '').trim() : '';
    const denyText = (denyBtn.textContent || '').trim();

    let description = '';
    const dialog = container;
    if (dialog) {
        const descEl = dialog.querySelector('p, .description, [data-testid="description"]');
        if (descEl) {
            description = (descEl.textContent || '').trim();
        }
    }

    if (!description) {
        let ancestor = approveBtn.parentElement;
        for (let i = 0; i < 8 && ancestor && ancestor !== scope.parentElement && ancestor !== document.body; i++) {
            const clone = ancestor.cloneNode(true);
            const clickables = Array.from(clone.querySelectorAll('button, span, div, [role="button"], label'));
            clickables.forEach(b => {
                const isButton = b.tagName === 'BUTTON' || b.tagName === 'LABEL' || b.getAttribute('role') === 'button';
                const hasCursorPointer = b.classList.contains('cursor-pointer');
                if (isButton || hasCursorPointer) {
                    try { b.remove(); } catch (e) {}
                }
            });
            const text = (clone.textContent || '').trim().replace(/\\\\s+/g, ' ');
            if (text.length > 3 && text.length < 200) {
                description = text;
                break;
            }
            ancestor = ancestor.parentElement;
        }
    }

    if (!description) {
        const ariaLabel = approveBtn.getAttribute('aria-label') || '';
        if (ariaLabel) description = ariaLabel;
    }

    let isGenerating = false;
    const stopEl = scope.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (stopEl) {
        isGenerating = true;
    } else {
        const stopPatterns = ['stop', 'stop generating', '停止', '生成を停止'];
        const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
        for (const btn of buttons) {
            const t = (btn.textContent || '').trim().toLowerCase();
            if (stopPatterns.some(p => t === p || t.includes(p))) {
                isGenerating = true;
                break;
            }
        }
    }

    return { approveText, alwaysAllowText, denyText, description, isGenerating };
})()`;

/**
 * Press the toggle on the right side of Allow Once to expand the Always Allow dropdown.
 */
const EXPAND_ALWAYS_ALLOW_MENU_SCRIPT = `(() => {
    const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', '今回のみ許可', '1回のみ許可', '一度許可', 'разрешить один раз', 'разрешить раз', 'однократно'];
    const ALWAYS_ALLOW_PATTERNS = [
        'allow this conversation',
        'allow this chat',
        'always allow',
        '常に許可',
        'この会話を許可',
        'разрешить для этой беседы',
        'разрешить для этого чата',
        'разрешать всегда',
        'всегда разрешать',
    ];

    const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visibleButtons = Array.from(document.querySelectorAll('button'))
        .filter(btn => btn.offsetParent !== null);

    const directAlways = visibleButtons.find(btn => {
        const t = normalize(btn.textContent || '');
        return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
    });
    if (directAlways) return { ok: true, reason: 'already-visible' };

    const allowOnceBtn = visibleButtons.find(btn => {
        const t = normalize(btn.textContent || '');
        return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
    });
    if (!allowOnceBtn) return { ok: false, error: 'allow-once button not found' };

    const container = allowOnceBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog')
        || allowOnceBtn.parentElement?.parentElement
        || allowOnceBtn.parentElement
        || document.body;

    const containerButtons = Array.from(container.querySelectorAll('button'))
        .filter(btn => btn.offsetParent !== null);

    const toggleBtn = containerButtons.find(btn => {
        if (btn === allowOnceBtn) return false;
        const text = normalize(btn.textContent || '');
        const aria = normalize(btn.getAttribute('aria-label') || '');
        const hasPopup = btn.getAttribute('aria-haspopup');
        if (hasPopup === 'menu' || hasPopup === 'listbox') return true;
        if (text === '') return true;
        return /menu|more|expand|options|dropdown|chevron|arrow/.test(aria);
    });

    if (toggleBtn) {
        toggleBtn.click();
        return { ok: true, reason: 'toggle-button' };
    }

    const rect = allowOnceBtn.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { ok: false, error: 'allow-once button rect unavailable' };
    }

    const clickX = rect.right - Math.max(4, Math.min(12, rect.width * 0.15));
    const clickY = rect.top + rect.height / 2;

    const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
    for (const type of events) {
        allowOnceBtn.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: clickX,
            clientY: clickY,
        }));
    }
    return { ok: true, reason: 'allow-once-right-edge' };
})()`;

/**
 * Generate a CDP script that clicks a button
 *
 * @param buttonText Text of the button to click
 */
export function buildClickScript(buttonText: string): string {
    const safeText = JSON.stringify(buttonText);
    return `(() => {
        const normalize = (text) => (text || '').toLowerCase().replace(/\\\\s+/g, ' ').trim();
        const text = ${safeText};
        const wanted = normalize(text);
        const panel = document.querySelector('.antigravity-agent-side-panel');
        const scope = panel || document;
        const allClickables = Array.from(scope.querySelectorAll('button, [role="button"], .cursor-pointer, label'))
            .filter(el => {
                const isButton = el.tagName === 'BUTTON' || el.tagName === 'LABEL' || el.getAttribute('role') === 'button';
                const hasCursorPointer = el.classList.contains('cursor-pointer');
                if (!isButton && !hasCursorPointer) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const target = allClickables.find(btn => {
            const buttonText = normalize(btn.textContent || '');
            const ariaLabel = normalize(btn.getAttribute('aria-label') || '');
            return buttonText === wanted ||
                ariaLabel === wanted ||
                buttonText.includes(wanted) ||
                ariaLabel.includes(wanted);
        });
        if (!target) return { ok: false, error: 'Button not found: ' + text };

        const triggerClick = (el) => {
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const eventTypes = ['pointerdown', 'mousedown', 'mouseup', 'click'];
            for (const type of eventTypes) {
                el.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: x,
                    clientY: y
                }));
            }
        };

        triggerClick(target);

        const radio = target.querySelector('input[type="radio"], input[type="checkbox"]');
        if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const container = target.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-2xl"], div[class*="rounded-lg"], div[class*="border"]')
            || target.parentElement?.parentElement
            || target.parentElement;
        if (container) {
            const submitBtn = Array.from(container.querySelectorAll('button')).find(btn => {
                const t = normalize(btn.textContent || '');
                return t === 'submit' || t.startsWith('submit');
            });
            if (submitBtn) {
                triggerClick(submitBtn);
                return { ok: true, submitted: true };
            }
        }
        return { ok: true };
    })()`;
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
            const callParams: Record<string, unknown> = {
                expression: DETECT_APPROVAL_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            const info: ApprovalInfo | null = result?.result?.value ?? null;

            if (info) {
                // Duplicate prevention: use approveText + description combination as key
                const key = `${info.approveText}::${info.description}`;
                if (key !== this.lastDetectedKey) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    Promise.resolve(this.onApprovalRequired(info)).catch((err) => {
                        logger.error('[ApprovalDetector] onApprovalRequired callback failed:', err);
                    });
                }
            } else {
                // Reset when buttons disappear (prepare for next approval detection)
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
            logger.error('[ApprovalDetector] Error during polling:', error);
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
            'разрешить для этой беседы',
            'разрешить для этого чата',
            'разрешать всегда',
            'всегда разрешать',
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

        for (const candidate of directCandidates) {
            if (await this.clickButton(candidate)) return true;
        }

        const expanded = await this.runEvaluateScript(EXPAND_ALWAYS_ALLOW_MENU_SCRIPT);
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
