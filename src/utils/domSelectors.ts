import { extractAssistantSegmentsPayloadScript } from '../services/assistantDomExtractor';

/**
 * Centralized DOM selectors and evaluate scripts for Antigravity IDE interaction.
 * Modify these constants if the Antigravity IDE layout or CSS classes change.
 */

// General UI selectors
export const CORE_SELECTORS = {
    /** Chat input box: textbox excluding xterm */
    CHAT_INPUT: 'div[role="textbox"]:not(.xterm-helper-textarea), div[role="combobox"]:not(.xterm-helper-textarea)',
    /** Submit button container */
    SUBMIT_BUTTON_CONTAINER: 'button',
    /** Submit icon SVG class candidates */
    SUBMIT_BUTTON_SVG_CLASSES: ['lucide-arrow-right', 'lucide-arrow-up', 'lucide-send'],
    /** Keyword to identify message injection target context (legacy) */
    CONTEXT_URL_KEYWORD: 'cascade-panel',
    /** Antigravity agent side panel main container class */
    SIDE_PANEL: '.antigravity-agent-side-panel',
};

// Script to get the current chat session title from the panel header
export const GET_CURRENT_CHAT_TITLE_SCRIPT = `(() => {
    const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
    if (!panel) return null;
    const headerEl = panel.querySelector('div[class*="border-b"]');
    if (!headerEl) return null;
    const titleEl = headerEl.querySelector('div[class*="text-ellipsis"]');
    return titleEl ? (titleEl.textContent || '').trim() : null;
})()`;

// Dynamic script builder to click a button by its text (with word boundaries for short words)
export const buildClickScript = (buttonText: string): string => {
    const normalizedTarget = buttonText.toLowerCase().replace(/^\s*\d+[\s.)]*/, '').replace(/\s+/g, ' ').trim();
    return `(() => {
        const target = ${JSON.stringify(normalizedTarget)};
        const normalize = (val) => (val || '').toLowerCase().replace(/^\\s*\\d+[\\s.)]*/, '').replace(/\\s+/g, ' ').trim();
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
        const preferred = Array.from(document.querySelectorAll('button, [role="button"], a.monaco-button'))
            .filter(btn => btn.offsetParent !== null);
        const fallbacks = Array.from(document.querySelectorAll('label, .cursor-pointer'))
            .filter(btn => btn.offsetParent !== null);
        const buttons = [...preferred, ...fallbacks];
        
        for (const btn of buttons) {
            const text = normalize(btn.textContent || '');
            const aria = normalize(btn.getAttribute('aria-label') || '');
            const title = normalize(btn.getAttribute('title') || '');
            
            const matchesText = text === target || matchPattern(text, target);
            const matchesAria = aria === target || matchPattern(aria, target);
            const matchesTitle = title === target || matchPattern(title, target);
            
            if ((matchesText || matchesAria || matchesTitle) && typeof btn.click === 'function') {
                btn.click();
                
                // Auto-submit form if this was a label/option and there's a Submit button in the container
                let container = btn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-"], div[class*="border"]');
                if (!container) {
                    let curr = btn.parentElement;
                    for (let i = 0; i < 5 && curr; i++) {
                        if (curr.querySelector('button')) {
                            const hasSubmit = Array.from(curr.querySelectorAll('button')).some(b => {
                                const t = (b.textContent || '').toLowerCase().trim();
                                return t === 'submit' || t.startsWith('submit');
                            });
                            if (hasSubmit) {
                                container = curr;
                                break;
                            }
                        }
                        curr = curr.parentElement;
                    }
                }
                if (container) {
                    const submitBtn = Array.from(container.querySelectorAll('button, [role="button"]'))
                        .find(b => {
                            const t = (b.textContent || '').toLowerCase().trim();
                            return t === 'submit' || t.startsWith('submit');
                        });
                    if (submitBtn && submitBtn !== btn && typeof submitBtn.click === 'function') {
                        setTimeout(() => {
                            try { submitBtn.click(); } catch(e) {}
                        }, 200);
                    }
                }
                
                return { ok: true, text: btn.textContent };
            }
        }
        return { ok: false, error: 'Button not found: ' + target };
    })()`;
};

// Planning Mode Selectors
export const PLANNING_SELECTORS = {
    ARTIFACT_CHIP: 'div.artifact-card, div[class*="artifact-card"], div[class*="border-gray-500"][class*="select-none"]',
    
    CAPTURE_BASELINE_SCRIPT: `(() => {
        const chipSelector = 'div.artifact-card, div[class*="artifact-card"], div[class*="border-gray-500"][class*="select-none"]';
        return {
            notifyCount: document.querySelectorAll('.notify-user-container').length,
            cardCount: document.querySelectorAll(chipSelector).length,
            iconCount: document.querySelectorAll('[class*="implementation-plan-icon"]').length
        };
    })()`,
    
    buildDetectPlanningScript: (
        lastClickedText: string | null,
        autoOpenedChips: string[],
        baselineNotifyCount: number,
        baselineCardCount: number,
        baselineIconCount: number,
    ) => `(() => {
        try {
            const OPEN_PATTERNS = ['open', 'view'];
            const PROCEED_PATTERNS = ['proceed', 'accept', 'approve', 'continue'];
            const PLAN_TYPE_KEYWORDS = ['implementation plan', 'implementation_plan', 'plan', 'walkthrough', 'task'];
            const lastClickedText = ${lastClickedText ? JSON.stringify(lastClickedText) : 'null'};
            const AUTO_OPENED_CHIPS = ${JSON.stringify(autoOpenedChips)};
            const BASELINE_NOTIFY = ${baselineNotifyCount};
            const BASELINE_CARD = ${baselineCardCount};
            const BASELINE_ICON = ${baselineIconCount};

            const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();

            const allContainers = Array.from(document.querySelectorAll('.notify-user-container'))
                .filter(el => !el.closest('[aria-label="Message history"]'));
            const newContainers = allContainers.slice(BASELINE_NOTIFY);
            let container = newContainers.length > 0 ? newContainers[newContainers.length - 1] : null;
            let openBtn = null;
            let proceedBtn = null;
            let openOnCard = false;

            if (container) {
                const allButtons = Array.from(container.querySelectorAll('button')).filter(btn => btn.offsetParent !== null);
                openBtn = allButtons.find(btn => { const t = normalize(btn.textContent); return OPEN_PATTERNS.some(p => t === p || t.includes(p)); });
                proceedBtn = allButtons.find(btn => { const t = normalize(btn.textContent); return PROCEED_PATTERNS.some(p => t === p || t.includes(p)); });
            }

            if (!openBtn && newContainers.length > 0) {
                for (let ci = newContainers.length - 1; ci >= 0; ci--) {
                    const c = newContainers[ci];
                    const btns = Array.from(c.querySelectorAll('button')).filter(btn => btn.offsetParent !== null);
                    const ob = btns.find(btn => { const t = normalize(btn.textContent); return OPEN_PATTERNS.some(p => t === p || t.includes(p)); });
                    if (ob) {
                        openBtn = ob;
                        container = c;
                        proceedBtn = btns.find(btn => { const t = normalize(btn.textContent); return PROCEED_PATTERNS.some(p => t === p || t.includes(p)); });
                        break;
                    }
                }
            }

            if (!openBtn || !container) {
                const chipSelector = 'div.artifact-card, div[class*="artifact-card"], div[class*="border-gray-500"][class*="select-none"]';
                const allCards = Array.from(document.body.querySelectorAll(chipSelector))
                    .filter(el => el.offsetParent !== null && !el.closest('[aria-label="Message history"]'));
                const newCards = allCards.slice(BASELINE_CARD);

                for (let i = newCards.length - 1; i >= 0; i--) {
                    const card = newCards[i];
                    const cardText = (card.textContent || '').trim();
                    if (!cardText || cardText.length > 500) continue;

                    const parent = card.parentElement || card;
                    const buttons = Array.from(parent.querySelectorAll('button'))
                        .filter(btn => btn.offsetParent !== null);
                    let ob = buttons.find(btn => {
                        const t = normalize(btn.textContent);
                        return OPEN_PATTERNS.some(p => t === p || t.includes(p));
                    });
                    const pb = buttons.find(btn => {
                        const t = normalize(btn.textContent);
                        return PROCEED_PATTERNS.some(p => t === p || t.includes(p));
                    });

                    if (!ob && (card.classList.contains('artifact-card') || card.querySelector('.artifact-card') || card.getAttribute('class')?.includes('artifact-card'))) {
                        ob = card;
                        openOnCard = true;
                    }

                    if (ob) {
                        openBtn = ob;
                        proceedBtn = pb || null;
                        container = card;
                        break;
                    }

                    const hasPlanIcon = !!card.querySelector('[class*="implementation-plan-icon"]')
                        || !!card.querySelector('[class*="walkthrough-icon"]')
                        || !!card.querySelector('[class*="task-icon"]');
                    const cardTextNorm = normalize(card.textContent);
                    const looksLikePlan = hasPlanIcon || PLAN_TYPE_KEYWORDS.some(k => cardTextNorm.includes(k));

                    if (looksLikePlan) {
                        const innerChip = card.querySelector('span[class*="inline-flex"][class*="cursor-pointer"]');
                        const clickTarget = innerChip || (card.classList.contains('cursor-pointer') ? card : null);
                        if (clickTarget) {
                            const chipText = (clickTarget.textContent || '').trim();
                            if (chipText && chipText.length < 100) {
                                openBtn = clickTarget;
                                openOnCard = true;
                                proceedBtn = null;
                                container = card;
                                break;
                            }
                        }
                    }
                }

                if (!openBtn) {
                    const allIconEls = Array.from(document.querySelectorAll('[class*="implementation-plan-icon"]'))
                        .filter(el => el.offsetParent !== null && !el.closest('[aria-label="Message history"]'));
                    const newIconEls = allIconEls.slice(BASELINE_ICON);

                    for (let k = newIconEls.length - 1; k >= 0; k--) {
                        const iconEl = newIconEls[k];
                        let refEl = iconEl.parentElement;
                        for (let up = 0; up < 5 && refEl; up++) {
                            if (refEl.classList.contains('cursor-pointer') || refEl.getAttribute('role') === 'button') break;
                            refEl = refEl.parentElement;
                        }

                        const titleNode = iconEl.closest('[class*="monaco-icon-label"]') ||
                            iconEl.parentElement;
                        const rawTitle = (titleNode?.textContent || '').trim();
                        const PLAN_PREFIX_RE = /^(implementation plan|implementation_plan|walkthrough|task)\s*/i;
                        const planTitle = rawTitle.replace(PLAN_PREFIX_RE, '').trim() || rawTitle || 'Implementation Plan';

                        return {
                            openText: 'Open',
                            proceedText: null,
                            planTitle,
                            planSummary: '',
                            description: '',
                            fileRefMode: true,
                        };
                    }

                    return null;
                }
            }

            const openText = openOnCard ? 'Open' : (openBtn.textContent || '').trim();
            const proceedText = proceedBtn ? (proceedBtn.textContent || '').trim() : null;

            const titleEl = container.querySelector('span.inline-flex.break-all, .inline-flex.break-all, span.break-all, span.select-text.break-all, .font-mono.text-sm.truncate, .font-mono.truncate');
            let planTitle = titleEl ? (titleEl.textContent || '').trim() : '';

            if (!planTitle && openText) {
                const match = openText.match(/open\\s+(.*)/i);
                if (match) planTitle = match[1].trim();
            }

            if (!planTitle) {
                const possibleTitleEl = container.querySelector('[class*="title"], [class*="name"], span');
                if (possibleTitleEl) {
                    planTitle = (possibleTitleEl.textContent || '').trim();
                }
            }

            if (!planTitle) {
                planTitle = (container.textContent || '').split('\\n')[0].trim().slice(0, 60);
            }

            if (planTitle.length > 100) {
                planTitle = planTitle.slice(0, 100) + '...';
            }

            const summaryEls = Array.from(container.querySelectorAll('span.text-sm'));
            const planSummary = summaryEls
                .map(el => (el.textContent || '').trim())
                .filter(text => text.length > 0 && text !== openText && text !== proceedText && text !== planTitle)
                .join(' ');

            const descEl = container.querySelector('.leading-relaxed.select-text');
            let description = '';
            const SKIP_TAGS = new Set(['PRE', 'CODE', 'STYLE', 'SCRIPT', 'BUTTON']);
            const walkToText = (el) => {
                const parts = [];
                const walk = (node) => {
                    if (node.nodeType === 3) {
                        const t = node.textContent || '';
                        if (t.trim()) parts.push(t.trim());
                    } else if (node.nodeType === 1 && !SKIP_TAGS.has(node.tagName)) {
                        for (const child of node.childNodes) walk(child);
                    }
                };
                walk(el);
                return parts.join(' ').slice(0, 500);
            };
            if (descEl) {
                description = walkToText(descEl);
            } else {
                const fullText = walkToText(container);
                const strippedParts = [planTitle, openText, proceedText, planSummary].filter(Boolean);
                description = strippedParts.reduce((t, s) => t.replace(s, ''), fullText).replace(/\\s+/g, ' ').trim();
            }

            return { openText, proceedText, planTitle, planSummary, description, openOnCard };
        } catch (e) {
            return null;
        }
    })()`,

    buildExtractPlanContentScript: (
        baselineNotifyCount: number,
        baselineCardCount: number,
    ) => `(() => {
        const BASELINE_NOTIFY = ${baselineNotifyCount};
        const BASELINE_CARD = ${baselineCardCount};

        const htmlToMd = (el) => {
            const parts = [];
            const process = (node) => {
                if (node.nodeType === 3) {
                    parts.push(node.textContent || '');
                    return;
                }
                if (node.nodeType !== 1) return;
                const tag = node.tagName;
                if (tag === 'H1') { parts.push('\\n# '); node.childNodes.forEach(process); parts.push('\\n'); return; }
                if (tag === 'H2') { parts.push('\\n## '); node.childNodes.forEach(process); parts.push('\\n'); return; }
                if (tag === 'H3') { parts.push('\\n### '); node.childNodes.forEach(process); parts.push('\\n'); return; }
                if (tag === 'H4') { parts.push('\\n#### '); node.childNodes.forEach(process); parts.push('\\n'); return; }
                if (tag === 'STRONG' || tag === 'B') { parts.push('**'); node.childNodes.forEach(process); parts.push('**'); return; }
                if (tag === 'EM' || tag === 'I') { parts.push('*'); node.childNodes.forEach(process); parts.push('*'); return; }
                if (tag === 'PRE') {
                    const code = node.querySelector('code');
                    const text = code ? (code.textContent || '') : (node.textContent || '');
                    parts.push('\\n\`\`\`\\n' + text + '\\n\`\`\`\\n');
                    return;
                }
                if (tag === 'CODE') { parts.push('\`' + (node.textContent || '') + '\`'); return; }
                if (tag === 'A') {
                    const href = node.getAttribute('href') || '';
                    parts.push('['); node.childNodes.forEach(process); parts.push('](' + href + ')');
                    return;
                }
                if (tag === 'LI') { parts.push('\\n- '); node.childNodes.forEach(process); return; }
                if (tag === 'BR') { parts.push('\\n'); return; }
                if (tag === 'P') { parts.push('\\n\\n'); node.childNodes.forEach(process); parts.push('\\n'); return; }
                if (tag === 'UL' || tag === 'OL') { node.childNodes.forEach(process); parts.push('\\n'); return; }
                if (tag === 'STYLE' || tag === 'SCRIPT') return;
                node.childNodes.forEach(process);
            };
            process(el);
            return parts.join('').replace(/\\n{3,}/g, '\\n\\n').trim();
        };

        const allContainers = Array.from(document.querySelectorAll('.notify-user-container'))
            .filter(el => !el.closest('[aria-label="Message history"]'));
        const newContainers = allContainers.slice(BASELINE_NOTIFY);

        for (let i = newContainers.length - 1; i >= 0; i--) {
            const container = newContainers[i];
            const contentDiv = container.querySelector('div.relative.pl-4.pr-4.py-1, div.relative.pl-4.pr-4');
            if (contentDiv) {
                const textEl = contentDiv.querySelector('.leading-relaxed.select-text');
                if (textEl) return htmlToMd(textEl);
            }
            const directLeading = container.querySelector('.leading-relaxed.select-text');
            if (directLeading) {
                const md = htmlToMd(directLeading);
                if (md.length > 50) return md;
            }
        }

        const chipSelector = 'div.artifact-card, div[class*="artifact-card"], div[class*="border-gray-500"][class*="select-none"]';
        const allCards = Array.from(document.body.querySelectorAll(chipSelector))
            .filter(el => !el.closest('[aria-label="Message history"]'));
        const newCards = allCards.slice(BASELINE_CARD);
        for (let i = newCards.length - 1; i >= 0; i--) {
            const card = newCards[i];
            const textEl = card.querySelector('.leading-relaxed.select-text');
            if (textEl) {
                const md = htmlToMd(textEl);
                if (md.length > 50) return md;
            }
        }

        const allContentDivs = Array.from(document.querySelectorAll('div.relative.pl-4.pr-4.py-1, div.relative.pl-4.pr-4'))
            .filter(el => !el.closest('[aria-label="Message history"]'));
        const newContentDivs = allContentDivs.slice(Math.max(BASELINE_NOTIFY, 0));
        for (let i = newContentDivs.length - 1; i >= 0; i--) {
            const textEl = newContentDivs[i].querySelector('.leading-relaxed.select-text');
            if (textEl) return htmlToMd(textEl);
        }

        return null;
    })()`,
    
    CHECK_LAST_MESSAGE_SCRIPT: `(() => {
        try {
            const OPEN_PATTERNS = ['open', 'view'];
            const PROCEED_PATTERNS = ['proceed', 'accept', 'approve', 'continue'];
            const PLAN_TYPE_KEYWORDS = ['implementation plan', 'implementation_plan', 'plan', 'walkthrough', 'task'];
            
            const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
            const isVisible = (el) => el && el.offsetParent !== null;

            const panel = document.querySelector('.antigravity-agent-side-panel');
            const rootScope = panel || document;
            const userMessages = rootScope.querySelectorAll('[role="article"][aria-label="User message"], [aria-label="User message"], [data-testid="user-input-step"]');
            const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;

            let assistantTurns = Array.from(rootScope.querySelectorAll('[data-message-author-role="assistant"], [role="article"][aria-label="Agent response"], [aria-label="Agent response"]'));
            let currentTurnScope = null;
            if (lastUserMsg) {
                assistantTurns = assistantTurns.filter(node => !!(lastUserMsg.compareDocumentPosition(node) & 4));
                currentTurnScope = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
            } else {
                currentTurnScope = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
            }
            if (!currentTurnScope) return null;

            const chipSelector = 'div.artifact-card, div[class*="artifact-card"], div[class*="border-gray-500"][class*="select-none"]';
            const card = currentTurnScope.querySelector(chipSelector);
            if (!card) return null;

            const parent = card.parentElement || card;
            const buttons = Array.from(parent.querySelectorAll('button')).filter(isVisible);
            let openBtn = buttons.find(btn => {
                const t = normalize(btn.textContent);
                return OPEN_PATTERNS.some(p => t === p || t.includes(p));
            });
            const proceedBtn = buttons.find(btn => {
                const t = normalize(btn.textContent);
                return PROCEED_PATTERNS.some(p => t === p || t.includes(p));
            });

            let openOnCard = false;
            if (!openBtn && (card.classList.contains('artifact-card') || card.querySelector('.artifact-card') || card.getAttribute('class')?.includes('artifact-card'))) {
                openBtn = card;
                openOnCard = true;
            }

            if (!openBtn) {
                const hasPlanIcon = !!card.querySelector('[class*="implementation-plan-icon"]')
                    || !!card.querySelector('[class*="walkthrough-icon"]')
                    || !!card.querySelector('[class*="task-icon"]');
                const cardTextNorm = normalize(card.textContent);
                const looksLikePlan = hasPlanIcon || PLAN_TYPE_KEYWORDS.some(k => cardTextNorm.includes(k));
                if (looksLikePlan) {
                    const innerChip = card.querySelector('span[class*="inline-flex"][class*="cursor-pointer"]');
                    const clickTarget = innerChip || (card.classList.contains('cursor-pointer') ? card : null);
                    if (clickTarget) {
                        openBtn = clickTarget;
                        openOnCard = true;
                    }
                }
            }

            if (!openBtn) return null;

            const openText = openOnCard ? 'Open' : (openBtn.textContent || '').trim();
            const proceedText = proceedBtn ? (proceedBtn.textContent || '').trim() : null;

            const titleEl = card.querySelector('span.inline-flex.break-all, .inline-flex.break-all, span.break-all, span.select-text.break-all, .font-mono.text-sm.truncate, .font-mono.truncate');
            let planTitle = titleEl ? (titleEl.textContent || '').trim() : '';

            if (!planTitle && openText) {
                const match = openText.match(/open\\s+(.*)/i);
                if (match) planTitle = match[1].trim();
            }

            if (!planTitle) {
                const possibleTitleEl = card.querySelector('[class*="title"], [class*="name"], span');
                if (possibleTitleEl) {
                    planTitle = (possibleTitleEl.textContent || '').trim();
                }
            }

            if (!planTitle) {
                planTitle = (card.textContent || '').split('\\n')[0].trim().slice(0, 60);
            }

            if (planTitle.length > 100) {
                planTitle = planTitle.slice(0, 100) + '...';
            }

            const summaryEls = Array.from(card.querySelectorAll('span.text-sm'));
            const planSummary = summaryEls
                .map(el => (el.textContent || '').trim())
                .filter(text => text.length > 0 && text !== openText && text !== proceedText && text !== planTitle)
                .join(' ');

            const descEl = card.querySelector('.leading-relaxed.select-text');
            let description = '';
            const SKIP_TAGS = new Set(['PRE', 'CODE', 'STYLE', 'SCRIPT', 'BUTTON']);
            const walkToText = (el) => {
                const parts = [];
                const walk = (node) => {
                    if (node.nodeType === 3) {
                        const t = node.textContent || '';
                        if (t.trim()) parts.push(t.trim());
                    } else if (node.nodeType === 1 && !SKIP_TAGS.has(node.tagName)) {
                        for (const child of node.childNodes) walk(child);
                    }
                };
                walk(el);
                return parts.join(' ').slice(0, 500);
            };
            if (descEl) {
                description = walkToText(descEl);
            } else {
                const fullText = walkToText(card);
                const strippedParts = [planTitle, openText, proceedText, planSummary].filter(Boolean);
                description = strippedParts.reduce((t, s) => t.replace(s, ''), fullText).replace(/\\s+/g, ' ').trim();
            }

            return { openText, proceedText, planTitle, planSummary, description, openOnCard };
        } catch (e) {
            return null;
        }
    })()`,
};

// Approval Mode Selectors
export const APPROVAL_SELECTORS = {
    DETECT_APPROVAL_SCRIPT: `(() => {
        try {
            const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', 'allow this time', '今回のみ許可', '1回のみ許可', '一度許可'];
            const ALWAYS_ALLOW_PATTERNS = [
                'allow this conversation',
                'allow this chat',
                'always allow',
                '常に許可',
                'この会話を許可',
            ];
            const ALLOW_PATTERNS = ['allow', 'permit', 'run', 'execute', 'accept', 'approve', '許可', '承認', '確認', '実行'];
            const DENY_PATTERNS = ['deny', 'reject', 'no', 'no (tell', '拒否', 'decline', '却下'];

            const normalize = (text) => (text || '').toLowerCase().replace(/^\\s*\\d+[\\s.)]*/, '').replace(/\\s+/g, ' ').trim();
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden';
            };

            const isExcluded = (el) => {
                if (!el) return true;
                return !!el.closest('.statusbar, [class*="statusbar"], .titlebar, [class*="titlebar"], .activitybar, [class*="activitybar"], [aria-label="Message history"]');
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

            const scope = document;

            const submitBtn = Array.from(scope.querySelectorAll('button')).find(btn => {
                if (!isVisible(btn)) return false;
                if (isExcluded(btn)) return false;
                const t = normalize(btn.textContent || '');
                return t === 'submit' || t.startsWith('submit');
            });

            if (submitBtn) {
                const container = submitBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-"], div[class*="border"]') || scope;
                const options = Array.from(container.querySelectorAll('label, button, [role="button"], .cursor-pointer'))
                    .filter(el => {
                        if (!isVisible(el)) return false;
                        if (isExcluded(el)) return false;
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
                                    if (!/^(yes|no|submit|cancel|ok|allow|deny|\\d+)$/i.test(text)) {
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

            const allClickables = Array.from(scope.querySelectorAll('button, [role="button"], a.monaco-button, .cursor-pointer'))
                .filter(el => {
                    const text = (el.textContent || '').trim();
                    if (text.length === 0 || text.length > 50) return false;
                    if (isExcluded(el)) return false;
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

            if (!approveBtn) {
                approveBtn = reversedClickables.find(btn => {
                    const t = normalize(btn.textContent || '');
                    return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
                }) || null;
            }

            if (!approveBtn) return null;

            let container = approveBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-2xl"], div[class*="rounded-lg"], div[class*="border"]');
            if (!container) {
                let el = approveBtn.parentElement;
                for (let i = 0; i < 6 && el && el !== document.body; i++) {
                    const clickables = Array.from(el.querySelectorAll('button, [role="button"], a.monaco-button, .cursor-pointer')).filter(b => {
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

            const containerClickables = Array.from(container.querySelectorAll('button, [role="button"], a.monaco-button, .cursor-pointer'))
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
            let alwaysAllowText = alwaysAllowBtn ? (alwaysAllowBtn.textContent || '').trim() : '';
            if (alwaysAllowText && normalize(alwaysAllowText) === normalize(approveText)) {
                alwaysAllowText = '';
            }
            const denyText = (denyBtn.textContent || '').trim();

            let description = '';
            const card = approveBtn.closest('div[class*="justify-between"], div[class*="outline-solid"], div[class*="border"]');
            if (card) {
                const bdis = Array.from(card.querySelectorAll('bdi'))
                    .map(el => (el.textContent || '').trim())
                    .filter(Boolean);
                if (bdis.length > 0) {
                    description = 'Review changes in: ' + bdis.join(', ');
                } else {
                    const fileSpans = Array.from(card.querySelectorAll('span'))
                        .map(el => (el.textContent || '').trim())
                        .filter(t => t && t.includes('.') && !t.includes(' ') && t.length > 2 && t.length < 80);
                    if (fileSpans.length > 0) {
                        description = 'Review changes in: ' + fileSpans.join(', ');
                    }
                }
            }

            if (!description && container && container !== scope && container !== document.body) {
                const descEl = container.querySelector('p, .description, [data-testid="description"]');
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
        } catch (e) {
            return null;
        }
    })()`,
    
    EXPAND_ALWAYS_ALLOW_MENU_SCRIPT: `(() => {
        const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', '今回のみ許可', '1回のみ許可', '一度许可'];
        const ALWAYS_ALLOW_PATTERNS = [
            'allow this conversation',
            'allow this chat',
            'always allow',
            '常に許可',
            'この会話を許可',
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

        if (!toggleBtn) return { ok: false, error: 'toggle button not found' };
        toggleBtn.click();
        return { ok: true, reason: 'clicked' };
    })()`,
};

// Response Monitor Selectors and Scripts
export const RESPONSE_SELECTORS = {
    RESPONSE_TEXT: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
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
        if (!scope) return null;

        const selectors = [
            { sel: '.rendered-markdown', score: 10 },
            { sel: '.leading-relaxed.select-text', score: 9 },
            { sel: '.flex.flex-col.gap-y-3', score: 8 },
            { sel: '[data-message-author-role="assistant"]', score: 7 },
            { sel: '[data-message-role="assistant"]', score: 6 },
            { sel: '[class*="assistant-message"]', score: 5 },
            { sel: '[class*="message-content"]', score: 4 },
            { sel: '[class*="markdown-body"]', score: 3 },
            { sel: '.prose', score: 2 },
        ];

        const looksLikeActivityLog = (text) => {
            const normalized = (text || '').trim().toLowerCase();
            if (!normalized) return false;
            const stripped = normalized.replace(/^[^a-z]+/i, '');
            const activityPattern = /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|fetching|connecting|creating|updating|deleting|installing|building|compiling|deploying|checking|scanning|parsing|resolving|downloading|uploading|analyzed|read|wrote|ran|created|updated|deleted|fetched|built|compiled|installed|resolved|downloaded|connected)\\b/i;
            if (activityPattern.test(stripped) && normalized.length <= 220) return true;
            if (/^initiating\\s/i.test(stripped) && normalized.length <= 500) return true;
            if (/^thought for\\s/i.test(stripped) && normalized.length <= 500) return true;
            return false;
        };

        const looksLikeFeedbackFooter = (text) => {
            const normalized = (text || '').trim().toLowerCase().replace(/\\s+/g, ' ');
            if (!normalized) return false;
            return normalized === 'good bad' || normalized === 'good' || normalized === 'bad';
        };

        const isInsideExcludedContainer = (node) => {
            if (node.closest('details')) return true;
            if (node.closest('[class*="feedback"], footer')) return true;
            if (node.closest('.notify-user-container')) return true;
            if (node.closest('[role="dialog"]')) return true;
            return false;
        };

        const looksLikeToolOutput = (text) => {
            const first = (text || '').trim().split('\\n')[0] || '';
            if (/^[a-z0-9._-]+\\s*\\/\\s*[a-z0-9._-]+$/i.test(first)) return true;
            if (/^full output written to\\b/i.test(first)) return true;
            if (/^output\\.[a-z0-9._-]+(?:#l\\d+(?:-\\d+)?)?$/i.test(first)) return true;
            var lower = (text || '').trim().toLowerCase();
            if (/^title:\\s/.test(lower) && /\\surl:\\s/.test(lower) && /\\ssnippet:\\s/.test(lower)) return true;
            if (/^(json|javascript|typescript|python|bash|sh|html|css|xml|yaml|yml|toml|sql|graphql|markdown|text|plaintext|log|ruby|go|rust|java|c|cpp|csharp|php|swift|kotlin)$/i.test(first)) return true;
            return false;
        };

        const looksLikeQuotaPopup = (text) => {
            var lower = (text || '').trim().toLowerCase();
            if (lower.includes('exhausted your quota') || lower.includes('exhausted quota')) return true;
            if (!lower.includes('model quota reached') && !lower.includes('quota exceeded') && !lower.includes('rate limit')) return false;
            return lower.includes('dismiss') || lower.includes('upgrade');
        };

        const combinedSelector = selectors.map((s) => s.sel).join(', ');
        const seen = new Set();

        const nodes = scope.querySelectorAll(combinedSelector);
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            if (!node || seen.has(node)) continue;
            seen.add(node);
            if (isInsideExcludedContainer(node)) continue;
            const text = (node.innerText || node.textContent || '').replace(/\\r/g, '').trim();
            if (!text || text.length < 2) continue;
            if (looksLikeActivityLog(text)) continue;
            if (looksLikeFeedbackFooter(text)) continue;
            if (looksLikeToolOutput(text)) continue;
            if (looksLikeQuotaPopup(text)) continue;
            return text;
        }

        return null;
    })()`,

    STOP_BUTTON: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
        const scopes = [panel, document].filter(Boolean);

        const isVisible = (el) => el && el.offsetParent !== null;

        let hasStop = false;
        for (const scope of scopes) {
            const el = scope.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (isVisible(el)) { hasStop = true; break; }
        }

        if (!hasStop) {
            const normalize = (value) => (value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
            const STOP_PATTERNS = [
                /^stop$/,
                /^stop generating$/,
                /^stop response$/,
                /^停止$/,
                /^生成を停止$/,
                /^応答を停止$/,
            ];
            const isStopLabel = (value) => {
                const normalized = normalize(value);
                if (!normalized) return false;
                return STOP_PATTERNS.some((re) => re.test(normalized));
            };
            outer: for (const scope of scopes) {
                const buttons = scope.querySelectorAll('button, [role="button"]');
                for (let i = 0; i < buttons.length; i++) {
                    const btn = buttons[i];
                    const labels = [
                        btn.textContent || '',
                        btn.getAttribute('aria-label') || '',
                        btn.getAttribute('title') || '',
                    ];
                    if (isVisible(btn) && labels.some(isStopLabel)) {
                        hasStop = true;
                        break outer;
                    }
                }
            }
        }

        if (hasStop) {
            let approvalVisible = false;
            for (const scope of scopes) {
                const candidateSpans = Array.from(scope.querySelectorAll('span, button'));
                for (const el of candidateSpans) {
                    const txt = (el.textContent || '').trim().toLowerCase();
                    const isClickable = el.classList.contains('cursor-pointer') || el.tagName === 'BUTTON';
                    if (isClickable && (txt === 'accept all' || txt === 'reject all' || txt === 'allow once' || txt === 'always allow')) {
                        approvalVisible = true;
                        break;
                    }
                }
                if (approvalVisible) break;
            }
            if (approvalVisible) {
                return { isGenerating: false };
            }
            return { isGenerating: true };
        }

        return { isGenerating: false };
    })()`,

    CHOICES: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
        const rootScope = panel || document;

        const userMessages = rootScope.querySelectorAll('[role="article"][aria-label="User message"], [aria-label="User message"], [data-testid="user-input-step"]');
        const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;

        let assistantTurns = Array.from(rootScope.querySelectorAll('[data-message-author-role="assistant"], [role="article"][aria-label="Agent response"], [aria-label="Agent response"]'));
        let lastTurn = null;
        if (lastUserMsg) {
            assistantTurns = assistantTurns.filter(node => !!(lastUserMsg.compareDocumentPosition(node) & 4));
            lastTurn = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
        } else {
            lastTurn = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
        }
        if (!lastTurn) return null;

        const SYSTEM_BUTTON_TEXTS = [
            'good', 'bad', 'copy', 'regenerate', 'stop', 'allow', 'deny', 'dismiss', 'retry', 'proceed', 'open', 'view',
            'accept all', 'reject all', 'allow once', 'always allow', 'allow this conversation', 'allow this chat'
        ];

        const getElementText = (node) => {
            if (node.nodeType === 3) {
                return node.nodeValue || '';
            }
            if (node.nodeType === 1) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return '';
                return Array.from(node.childNodes)
                    .map(getElementText)
                    .filter(Boolean)
                    .join(' ')
                    .replace(/\s+/g, ' ');
            }
            return '';
        };

        const isSystemOrActivityButton = (el, text) => {
            if (el.getAttribute('data-tooltip-id') === 'input-send-button-cancel-tooltip') return true;
            if (el.closest('.notify-user-container') || el.closest('[class*="notify-user"]')) return true;
            if (el.closest('[class*="tool-call"]') || el.closest('[class*="activity"]')) return true;
            if (el.closest('[class*="feedback"]') || el.closest('footer')) return true;
            if (el.closest('[class*="metadata"]') || el.closest('[class*="metrics"]')) return true;
            
            // Exclude workspace file/folder links and draggable VS Code resource elements
            if (el.getAttribute('draggable') === 'true') return true;
            if (el.tagName === 'A' || el.closest('a')) return true;
            if (el.querySelector('img[src*="icon"], img[src*="file"], img[src*="document"], img[src*="symbols"]')) return true;
            
            const normalized = text.toLowerCase().trim()
                .replace(/([a-z])(\d)/g, '$1 $2')
                .replace(/(\d)([a-z])/g, '$1 $2')
                .replace(/\s+/g, ' ');

            if (/^(?:explored|explore|exploring|thought|thinking|run|running|ran|npm|npx|git|python|tsc|test|testing|search|searching|artifact|task|tasks|status|scan|scanning|inspect|inspecting|read|reading|write|writing|resolve|resolving|execute|executing|analyze|analyzing|install|installing|build|building|compile|compiling)\b/i.test(normalized)) return true;
            if (/\b(?:seconds|credits|worked for|gemini|claude)\b/i.test(normalized)) return true;
            if (/отменить|остановить|cancel/i.test(normalized)) return true;
            if (/^[+-]\d+\s+[+-]\d+$/.test(normalized)) return true;
            if (/\.[a-z0-9]{1,4}$/i.test(normalized)) return true;
            if (normalized.includes('/') || normalized.includes('\\')) return true;
            
            return false;
        };

        const buttons = Array.from(lastTurn.querySelectorAll('button, [role="button"], .cursor-pointer'))
            .filter(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                
                const text = getElementText(el).trim();
                if (!text || text.length > 80) return false;

                const ltext = text.toLowerCase();
                if (SYSTEM_BUTTON_TEXTS.some(p => ltext === p || ltext.startsWith(p) || ltext.endsWith(p))) return false;
                if (ltext.includes('worked for') || ltext.includes('seconds') || ltext.includes('credits') || ltext.includes('gemini') || ltext.includes('claude')) return false;
                if (el.closest('pre') || el.closest('code') || el.closest('details')) return false;
                if (isSystemOrActivityButton(el, text)) return false;

                return true;
            });

        if (buttons.length === 0) return null;

        return buttons.map(btn => getElementText(btn).trim());
    })()`,

    CLICK_STOP_BUTTON: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
        const scopes = [panel, document].filter(Boolean);

        const isVisible = (el) => el && el.offsetParent !== null;

        for (const scope of scopes) {
            const el = scope.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (isVisible(el) && typeof el.click === 'function') {
                el.click();
                return { ok: true, method: 'tooltip-id' };
            }
        }

        const normalize = (value) => (value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const STOP_PATTERNS = [
            /stop$/,
            /stop generating$/,
            /stop response$/,
            /停止$/,
            /生成を停止$/,
            /応答を停止$/,
        ];
        const isStopLabel = (value) => {
            const normalized = normalize(value);
            if (!normalized) return false;
            return STOP_PATTERNS.some((re) => re.test(normalized));
        };
        for (const scope of scopes) {
            const buttons = scope.querySelectorAll('button, [role="button"]');
            for (let i = 0; i < buttons.length; i++) {
                const btn = buttons[i];
                const labels = [
                    btn.textContent || '',
                    btn.getAttribute('aria-label') || '',
                    btn.getAttribute('title') || '',
                ];
                if (isVisible(btn) && labels.some(isStopLabel) && typeof btn.click === 'function') {
                    btn.click();
                    return { ok: true, method: 'text-match', label: btn.textContent };
                }
            }
        }

        return { ok: false, error: 'Stop button not found' };
    })()`,

    PROCESS_LOGS: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
        const scopes = [panel, document].filter(Boolean);

        const selectors = [
            { sel: '.rendered-markdown', score: 10 },
            { sel: '.leading-relaxed.select-text', score: 9 },
            { sel: '.flex.flex-col.gap-y-3', score: 8 },
            { sel: '[data-message-author-role="assistant"]', score: 7 },
            { sel: '[data-message-role="assistant"]', score: 6 },
            { sel: '[class*="assistant-message"]', score: 5 },
            { sel: '[class*="message-content"]', score: 4 },
            { sel: '[class*="markdown-body"]', score: 3 },
            { sel: '.prose', score: 2 },
        ];

        const looksLikeActivityLog = (text) => {
            const normalized = (text || '').trim().toLowerCase();
            if (!normalized) return false;
            const stripped = normalized.replace(/^[^a-z]+/i, '');
            const activityPattern = /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|fetching|connecting|creating|updating|deleting|installing|building|compiling|deploying|checking|scanning|parsing|resolving|downloading|uploading|analyzed|read|wrote|ran|created|updated|deleted|fetched|built|compiled|installed|resolved|downloaded|connected)\\b/i;
            if (activityPattern.test(stripped) && normalized.length <= 220) return true;
            if (/^initiating\\s/i.test(stripped) && normalized.length <= 500) return true;
            if (/^thought for\\s/i.test(stripped) && normalized.length <= 500) return true;
            return false;
        };

        const looksLikeToolOutput = (text) => {
            const first = (text || '').trim().split('\\n')[0] || '';
            if (/^[a-z0-9._-]+\\s*\\/\\s*[a-z0-9._-]+$/i.test(first)) return true;
            if (/^full output written to\\b/i.test(first)) return true;
            if (/^output\\.[a-z0-9._-]+(?:#l\\d+(?:-\\d+)?)?$/i.test(first)) return true;
            var lower = (text || '').trim().toLowerCase();
            if (/^title:\\s/.test(lower) && /\\surl:\\s/.test(lower) && /\\ssnippet:\\s/.test(lower)) return true;
            if (/^(json|javascript|typescript|python|bash|sh|html|css|xml|yaml|yml|toml|sql|graphql|markdown|text|plaintext|log|ruby|go|rust|java|c|cpp|csharp|php|swift|kotlin)$/i.test(first)) return true;
            return false;
        };

        const isInsideExcludedContainer = (node) => {
            if (node.closest('details')) return true;
            if (node.closest('[class*="feedback"], footer')) return true;
            if (node.closest('.notify-user-container')) return true;
            if (node.closest('[role="dialog"]')) return true;
            return false;
        };

        const results = [];
        const seen = new Set();

        for (const scope of scopes) {
            for (const { sel } of selectors) {
                const nodes = scope.querySelectorAll(sel);
                for (let i = 0; i < nodes.length; i++) {
                    const node = nodes[i];
                    if (!node || seen.has(node)) continue;
                    seen.add(node);
                    if (isInsideExcludedContainer(node)) continue;
                    const text = (node.innerText || node.textContent || '').replace(/\\r/g, '').trim();
                    if (!text || text.length < 4) continue;
                    if (looksLikeActivityLog(text) || looksLikeToolOutput(text)) {
                        results.push(text.slice(0, 300));
                    }
                }
            }
        }

        return results;
    })()`,

    COMBINED_POLL_TEMPLATE: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
        const scopes = [panel, document].filter(Boolean);

        const rootScope = panel || document;
        const userMessages = rootScope.querySelectorAll('[role="article"][aria-label="User message"], [aria-label="User message"], [data-testid="user-input-step"]');
        const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;

        let assistantTurns = Array.from(rootScope.querySelectorAll('[data-message-author-role="assistant"], [role="article"][aria-label="Agent response"], [aria-label="Agent response"]'));
        let currentTurnScope = null;
        if (lastUserMsg) {
            assistantTurns = assistantTurns.filter(node => !!(lastUserMsg.compareDocumentPosition(node) & 4));
            currentTurnScope = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
        } else {
            currentTurnScope = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : rootScope;
        }
        const turnScopes = currentTurnScope ? [currentTurnScope] : [];

        const isVisible = (el) => el && el.offsetParent !== null;

        let isGenerating = false;
        for (const scope of scopes) {
            const el = scope.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (isVisible(el)) { isGenerating = true; break; }
        }
        if (!isGenerating) {
            const normalize = (value) => (value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
            const STOP_PATTERNS = [/^stop$/, /^stop generating$/, /^stop response$/, /^停止$/, /^生成を停止$/, /^応答を停止$/];
            const isStopLabel = (value) => { const n = normalize(value); return n ? STOP_PATTERNS.some((re) => re.test(n)) : false; };
            outer: for (const scope of scopes) {
                const buttons = scope.querySelectorAll('button, [role="button"]');
                for (let i = 0; i < buttons.length; i++) {
                    const btn = buttons[i];
                    if (isVisible(btn) && [btn.textContent || '', btn.getAttribute('aria-label') || '', btn.getAttribute('title') || ''].some(isStopLabel)) {
                        isGenerating = true; break outer;
                    }
                }
            }
        }
        const checkApprovalActive = () => {
            const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', 'allow this time', '今回のみ許可', '1回のみ許可', '一度許可'];
            const ALWAYS_ALLOW_PATTERNS = ['allow this conversation', 'allow this chat', 'always allow', '常に許可', 'この会話を許可'];
            const ALLOW_PATTERNS = ['allow', 'permit', 'run', 'execute', 'accept', 'approve', '許可', '承認', '確認', '実行'];
            const DENY_PATTERNS = ['deny', 'reject', 'no', 'no (tell', '拒否', 'decline', '却下'];

            const normalize = (text) => (text || '').toLowerCase().replace(/^\\s*\\d+[\\s.)]*/, '').replace(/\\s+/g, ' ').trim();
            const isElVisible = (el) => {
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

            const scope = document;

            const submitBtn = Array.from(scope.querySelectorAll('button')).find(btn => {
                if (!isElVisible(btn)) return false;
                const t = normalize(btn.textContent || '');
                return t === 'submit' || t.startsWith('submit');
            });

            if (submitBtn) {
                const container = submitBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-"], div[class*="border"]') || scope;
                const options = Array.from(container.querySelectorAll('label, button, [role="button"], .cursor-pointer'))
                    .filter(el => {
                        if (!isElVisible(el)) return false;
                        const text = (el.textContent || '').trim();
                        return text.length > 0 && text.length < 80;
                    });

                const allowOnceOpt = options.find(el => {
                    const t = normalize(el.textContent || '');
                    return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
                });

                const denyOpt = options.find(el => {
                    const t = normalize(el.textContent || '');
                    return DENY_PATTERNS.some(p => {
                        if (p === 'no' && t.includes('no (tell')) return true;
                        return t === p || matchPattern(t, p);
                    });
                });

                if (allowOnceOpt && denyOpt) return true;
            }

            const allClickables = Array.from(scope.querySelectorAll('button, [role="button"], a.monaco-button'))
                .filter(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    if (text.length === 0 || text.length > 50) return false;
                    return isElVisible(el);
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

            if (!approveBtn) return false;

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

            if (!denyBtn) return false;

            return true;
        };

        const approvalVisible = checkApprovalActive();
        if (approvalVisible && isGenerating) {
            isGenerating = false;
        }

        let quotaError = false;
        const scope = panel || document;
        const QUOTA_KEYWORDS_PRIMARY = ['model quota reached', 'rate limit', 'quota exceeded', 'exhausted your quota', 'exhausted quota'];
        const QUOTA_KEYWORDS_FALLBACK = ['model quota reached', 'quota exceeded', 'exhausted your quota', 'exhausted quota'];
        const isInsideResponse = (node) =>
            node.closest('.rendered-markdown, .prose, pre, code, [data-message-author-role="assistant"], [data-message-role="assistant"], [class*="message-content"]');
        const headings = scope.querySelectorAll('h3 span, h3');
        for (const el of headings) {
            if (isInsideResponse(el)) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            if (QUOTA_KEYWORDS_PRIMARY.some(kw => text.includes(kw))) { quotaError = true; break; }
        }
        if (!quotaError) {
            const inlineSpans = scope.querySelectorAll('span');
            for (const el of inlineSpans) {
                if (isInsideResponse(el)) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                if (text.includes('exhausted your quota') || text.includes('exhausted quota')) { quotaError = true; break; }
            }
        }
        if (!quotaError) {
            const errorSelectors = ['[role="alert"]','[class*="error"]','[class*="warning"]','[class*="toast"]','[class*="banner"]','[class*="notification"]','[class*="alert"]','[class*="quota"]','[class*="rate-limit"]'];
            const errorElements = scope.querySelectorAll(errorSelectors.join(', '));
            for (const el of errorElements) {
                if (isInsideResponse(el)) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                if (QUOTA_KEYWORDS_FALLBACK.some(kw => text.includes(kw))) { quotaError = true; break; }
            }
        }

        let planningActive = false;
        const BASELINE_NOTIFY = __BASELINE_NOTIFY__;
        const BASELINE_CARD = __BASELINE_CARD__;
        const OPEN_PAT = ['open', 'view'];
        const btnNorm = function(btn) { return (btn.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim(); };

        const allContainers = Array.from(document.querySelectorAll('.notify-user-container'));
        const newContainers = allContainers.slice(BASELINE_NOTIFY);
        const container = newContainers.length > 0 ? newContainers[newContainers.length - 1] : null;

        if (container) {
            const buttons = Array.from(container.querySelectorAll('button')).filter(function(btn) { return btn.offsetParent !== null; });
            planningActive = buttons.some(function(btn) { var t = btnNorm(btn); return OPEN_PAT.some(function(p) { return t === p || t.includes(p); }); });
        }

        if (!planningActive) {
            const allCards = Array.from(document.body.querySelectorAll('div[class*="border"][class*="rounded-lg"]'));
            const newCards = allCards.slice(BASELINE_CARD);

            for (let i = newCards.length - 1; i >= 0; i--) {
                const card = newCards[i];
                const chip = card.querySelector('span[class*="inline-flex"][class*="cursor-pointer"]');
                if (chip && card.offsetParent !== null) {
                    const buttons = Array.from(card.querySelectorAll('button'));
                    const hasOpenOrProceed = buttons.some(function(btn) {
                        const t = btnNorm(btn);
                        return OPEN_PAT.some(function(p) { return t === p || t.includes(p); }) || t.includes('proceed');
                    });
                    if (!hasOpenOrProceed) {
                        planningActive = true;
                        break;
                    }
                }
            }
        }

        const selectors = [
            { sel: '.rendered-markdown', score: 10 },
            { sel: '.leading-relaxed.select-text', score: 9 },
            { sel: '.flex.flex-col.gap-y-3', score: 8 },
            { sel: '[data-message-author-role="assistant"]', score: 7 },
            { sel: '[data-message-role="assistant"]', score: 6 },
            { sel: '[class*="assistant-message"]', score: 5 },
            { sel: '[class*="message-content"]', score: 4 },
            { sel: '[class*="markdown-body"]', score: 3 },
            { sel: '.prose', score: 2 },
        ];
        const looksLikeActivityLog = (text) => {
            const normalized = (text || '').trim().toLowerCase();
            if (!normalized) return false;
            const stripped = normalized.replace(/^[^a-z]+/i, '');
            const activityPattern = /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|fetching|connecting|creating|updating|deleting|installing|building|compiling|deploying|checking|scanning|parsing|resolving|downloading|uploading|analyzed|read|wrote|ran|created|updated|deleted|fetched|built|compiled|installed|resolved|downloaded|connected)\\b/i;
            if (activityPattern.test(stripped) && normalized.length <= 220) return true;
            if (/^initiating\\s/i.test(stripped) && normalized.length <= 500) return true;
            if (/^thought for\\s/i.test(stripped) && normalized.length <= 500) return true;
            return false;
        };
        const looksLikeFeedbackFooter = (text) => {
            const normalized = (text || '').trim().toLowerCase().replace(/\\s+/g, ' ');
            if (!normalized) return false;
            return normalized === 'good bad' || normalized === 'good' || normalized === 'bad';
        };
        const isInsideExcludedContainer = (node) => {
            if (node.closest('details')) return true;
            if (node.closest('[class*="feedback"], footer')) return true;
            if (node.closest('.notify-user-container')) return true;
            if (node.closest('[role="dialog"]')) return true;
            return false;
        };
        const looksLikeToolOutput = (text) => {
            const first = (text || '').trim().split('\\n')[0] || '';
            if (/^[a-z0-9._-]+\\s*\\/\\s*[a-z0-9._-]+$/i.test(first)) return true;
            if (/^full output written to\\b/i.test(first)) return true;
            if (/^output\\.[a-z0-9._-]+(?:#l\\d+(?:-\\d+)?)?$/i.test(first)) return true;
            var lower = (text || '').trim().toLowerCase();
            if (/^title:\\s/.test(lower) && /\\surl:\\s/.test(lower) && /\\ssnippet:\\s/.test(lower)) return true;
            if (/^(json|javascript|typescript|python|bash|sh|html|css|xml|yaml|yml|toml|sql|graphql|markdown|text|plaintext|log|ruby|go|rust|java|c|cpp|csharp|php|swift|kotlin)$/i.test(first)) return true;
            return false;
        };
        const looksLikeQuotaPopup = (text) => {
            var lower = (text || '').trim().toLowerCase();
            if (lower.includes('exhausted your quota') || lower.includes('exhausted quota')) return true;
            if (!lower.includes('model quota reached') && !lower.includes('quota exceeded') && !lower.includes('rate limit')) return false;
            return lower.includes('dismiss') || lower.includes('upgrade');
        };
        const combinedSelector = selectors.map((s) => s.sel).join(', ');
        const seen = new Set();
        let responseText = null;
        for (const s of turnScopes) {
            const nodes = s.querySelectorAll(combinedSelector);
            for (let i = nodes.length - 1; i >= 0; i--) {
                const node = nodes[i];
                if (!node || seen.has(node)) continue;
                seen.add(node);
                if (isInsideExcludedContainer(node)) continue;
                const text = (node.innerText || node.textContent || '').replace(/\\r/g, '').trim();
                if (!text || text.length < 2) continue;
                if (looksLikeActivityLog(text)) continue;
                if (looksLikeFeedbackFooter(text)) continue;
                if (looksLikeToolOutput(text)) continue;
                if (looksLikeQuotaPopup(text)) continue;
                responseText = text;
                break;
            }
            if (responseText !== null) break;
        }

        const logSeen = new Set();
        const processLogs = [];
        for (const s of turnScopes) {
            for (const { sel } of selectors) {
                const nodes = s.querySelectorAll(sel);
                for (let i = 0; i < nodes.length; i++) {
                    const node = nodes[i];
                    if (!node || logSeen.has(node)) continue;
                    logSeen.add(node);
                    if (isInsideExcludedContainer(node)) continue;
                    const text = (node.innerText || node.textContent || '').replace(/\\r/g, '').trim();
                    if (!text || text.length < 4) continue;
                    if (looksLikeActivityLog(text) || looksLikeToolOutput(text)) {
                        processLogs.push(text.slice(0, 300));
                    }
                }
            }
        }

        // approvalVisible is already calculated strictly above

        const checkQuestionActive = () => {
            try {
                const submitBtn = Array.from(document.querySelectorAll('button'))
                    .find(btn => {
                        const t = (btn.textContent || '').trim().toLowerCase();
                        return t === 'submit' || t === 'continue' || t.startsWith('continue');
                    });
                if (!submitBtn) return false;

                const card = submitBtn.closest('div[class*="rounded-"], div[class*="border"], [role="dialog"], .modal') 
                    || submitBtn.parentElement?.parentElement;
                if (!card) return false;

                const skipBtn = Array.from(card.querySelectorAll('button, span, a'))
                    .find(el => {
                        const t = (el.textContent || '').trim().toLowerCase();
                        return t === 'skip';
                    });
                return !!skipBtn;
            } catch (e) {
                return false;
            }
        };
        const questionActive = checkQuestionActive();

        return { isGenerating, quotaError, planningActive, approvalActive: approvalVisible, questionActive, responseText, processLogs };
    })()`,

    QUOTA_ERROR: `(() => {
        const panel = document.querySelector('${CORE_SELECTORS.SIDE_PANEL}');
        const scope = panel || document;
        const QUOTA_KEYWORDS_PRIMARY = ['model quota reached', 'rate limit', 'quota exceeded', 'exhausted your quota', 'exhausted quota'];
        const QUOTA_KEYWORDS_FALLBACK = ['model quota reached', 'quota exceeded', 'exhausted your quota', 'exhausted quota'];
        const isInsideResponse = (node) =>
            node.closest('.rendered-markdown, .prose, pre, code, [data-message-author-role="assistant"], [data-message-role="assistant"], [class*="message-content"]');

        const headings = scope.querySelectorAll('h3 span, h3');
        for (const el of headings) {
            if (isInsideResponse(el)) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            if (QUOTA_KEYWORDS_PRIMARY.some(kw => text.includes(kw))) return true;
        }

        const inlineSpans = scope.querySelectorAll('span');
        for (const el of inlineSpans) {
            if (isInsideResponse(el)) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.includes('exhausted your quota') || text.includes('exhausted quota')) return true;
        }

        const errorSelectors = [
            '[role="alert"]',
            '[class*="error"]',
            '[class*="warning"]',
            '[class*="toast"]',
            '[class*="banner"]',
            '[class*="notification"]',
            '[class*="alert"]',
            '[class*="quota"]',
            '[class*="rate-limit"]',
        ];
        const errorElements = scope.querySelectorAll(errorSelectors.join(', '));
        for (const el of errorElements) {
            if (isInsideResponse(el)) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            if (QUOTA_KEYWORDS_FALLBACK.some(kw => text.includes(kw))) return true;
        }
        return false;
    })()`,

    RESPONSE_STRUCTURED: extractAssistantSegmentsPayloadScript(),
};

// Error Popup Selectors
export const ERROR_POPUP_SELECTORS = {
    DETECT_ERROR_POPUP_SCRIPT: `(() => {
        const ERROR_PATTERNS = [
            'agent terminated',
            'terminated due to error',
            'unexpected error',
            'something went wrong',
            'an error occurred',
        ];

        const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();

        // Try dialog/modal first
        const dialogs = Array.from(document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], .modal, .dialog'
        )).filter(el => el.offsetParent !== null || el.getAttribute('aria-modal') === 'true');

        // Fallback: look for fixed/absolute positioned overlays
        if (dialogs.length === 0) {
            const overlays = Array.from(document.querySelectorAll('div[class*="fixed"], div[class*="absolute"]'))
                .filter(el => {
                    const style = window.getComputedStyle(el);
                    return (style.position === 'fixed' || style.position === 'absolute')
                        && style.zIndex && parseInt(style.zIndex, 10) > 10
                        && el.querySelector('button');
                });
            dialogs.push(...overlays);
        }

        for (const dialog of dialogs) {
            const fullText = normalize(dialog.textContent || '');
            const isError = ERROR_PATTERNS.some(p => fullText.includes(p));
            if (!isError) continue;

            // Extract title from heading elements or first prominent text
            const headingEl = dialog.querySelector('h1, h2, h3, h4, [class*="title"], [class*="heading"]');
            const title = headingEl ? (headingEl.textContent || '').trim() : '';

            // Extract body text (excluding button text and title)
            const allButtons = Array.from(dialog.querySelectorAll('button'))
                .filter(btn => btn.offsetParent !== null);
            const buttonTexts = new Set(allButtons.map(btn => (btn.textContent || '').trim()));

            const bodyParts = [];
            const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const text = (node.textContent || '').trim();
                if (!text) continue;
                if (buttonTexts.has(text)) continue;
                if (text === title) continue;
                bodyParts.push(text);
            }
            const body = bodyParts.join(' ').slice(0, 1000);

            const buttons = allButtons.map(btn => (btn.textContent || '').trim()).filter(t => t.length > 0);

            if (buttons.length === 0) continue;

            return { title: title || 'Error', body, buttons };
        }

        return null;
    })()`,

    READ_CLIPBOARD_SCRIPT: `(async () => {
        try {
            const text = await navigator.clipboard.readText();
            return text || null;
        } catch (e) {
            return null;
        }
    })()`,
};

// Interactive Question Selectors
export const QUESTION_SELECTORS = {
    DETECT_QUESTION_SCRIPT: `(() => {
        try {
            const isSubmitOrContinue = (btn) => {
                const t = (btn.textContent || '').trim().toLowerCase();
                return t.includes('submit') || t.includes('continue');
            };
            const submitBtn = Array.from(document.querySelectorAll('button')).find(isSubmitOrContinue);
            if (!submitBtn) return null;

            const card = submitBtn.closest('div[class*="rounded-"], div[class*="border"], [role="dialog"], .modal') 
                || submitBtn.parentElement?.parentElement;
            if (!card) return null;

            const skipBtn = Array.from(card.querySelectorAll('button, span, a'))
                .find(el => (el.textContent || '').trim().toLowerCase() === 'skip');
            if (!skipBtn) return null;

            // Find options elements first to use as reference for title parsing
            const rawOptionElements = Array.from(card.querySelectorAll('label, div[role="radio"], div[role="checkbox"], div[class*="option"], div[class*="choice"]'));

            // Find question title by walking upwards/backwards from first option/group
            let question = '';
            const radioGroup = card.querySelector('[role="radiogroup"], [role="group"]');
            const referenceEl = radioGroup || rawOptionElements[0];
            if (referenceEl) {
                let sibling = referenceEl.previousElementSibling;
                const candidates = [];
                while (sibling) {
                    const text = (sibling.textContent || '').trim();
                    if (text) candidates.push(text);
                    sibling = sibling.previousElementSibling;
                }
                if (candidates.length === 0 && referenceEl.parentElement) {
                    let parentSibling = referenceEl.parentElement.previousElementSibling;
                    while (parentSibling) {
                        const text = (parentSibling.textContent || '').trim();
                        if (text) candidates.push(text);
                        parentSibling = parentSibling.previousElementSibling;
                    }
                }
                const validQuestions = candidates.filter(txt => {
                    const clean = txt.toLowerCase();
                    if (/^\\d+\\s+of\\s+\\d+$/.test(clean)) return false;
                    if (clean.includes('waiting for user input')) return false;
                    if (clean.includes('asking')) return false;
                    if (clean.includes('questions')) return false;
                    return true;
                });
                if (validQuestions.length > 0) {
                    question = validQuestions[0];
                }
            }

            if (!question) {
                const titleEl = card.querySelector('div[class*="title"], span[class*="title"], div[class*="header"], h1, h2, h3, h4');
                question = titleEl ? (titleEl.textContent || '').trim() : '';
            }
            if (!question) {
                const firstDiv = card.querySelector('div');
                if (firstDiv) question = (firstDiv.textContent || '').split('\\n')[0].trim();
            }
            if (!question) {
                question = (card.textContent || '').trim().split('\\n')[0];
            }
            question = question.replace(/^\\s*[?？]\\s*/, '').trim();

            // Find options (labels or interactive items)
            const options = [];
            const optionElements = rawOptionElements
                .filter(el => {
                    const inputEl = el.querySelector('textarea, input');
                    let txt = '';
                    if (inputEl) {
                        txt = (inputEl.placeholder || inputEl.getAttribute('placeholder') || '').trim();
                    }
                    if (!txt) {
                        txt = (el.textContent || '').trim();
                    }
                    return txt.length > 0 && txt.length < 200 
                        && !txt.toLowerCase().includes('submit') 
                        && !txt.toLowerCase().includes('skip')
                        && txt !== question;
                });

            const seenTexts = new Set();
            for (const el of optionElements) {
                const inputEl = el.querySelector('textarea, input');
                let txt = '';
                if (inputEl) {
                    txt = (inputEl.placeholder || inputEl.getAttribute('placeholder') || '').trim();
                }
                if (!txt) {
                    txt = el.textContent.trim();
                }
                txt = txt.replace(/^\\s*\\d+[\\s.)]*/, ''); // remove index
                if (txt && !seenTexts.has(txt)) {
                    seenTexts.add(txt);
                    options.push(txt);
                }
            }

            if (options.length === 0) {
                const divs = Array.from(card.querySelectorAll('div'))
                    .filter(d => d.children.length === 0 && d.textContent.trim().length > 0);
                for (const d of divs) {
                    const txt = d.textContent.trim().replace(/^\\s*\\d+[\\s.)]*/, '');
                    if (txt.length > 0 && txt.length < 250 
                        && !txt.toLowerCase().includes('submit') 
                        && !txt.toLowerCase().includes('skip') 
                        && !txt.includes(question)) {
                        if (!seenTexts.has(txt)) {
                            seenTexts.add(txt);
                            options.push(txt);
                        }
                    }
                }
            }

            const hasCheckboxes = card.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;
            const isMultiSelect = hasCheckboxes || (card.textContent || '').toLowerCase().includes('select all');
            const key = \`\${question}::\${options.join('|')}::\${isMultiSelect}\`;

            return { question, options, isMultiSelect, key };
        } catch (e) {
            return null;
        }
    })()`,

    buildClickQuestionOptionScript: (optionIndex: number) => `(() => {
        try {
            const isSubmitOrContinue = (btn) => {
                const t = (btn.textContent || '').trim().toLowerCase();
                return t.includes('submit') || t.includes('continue');
            };
            const submitBtn = Array.from(document.querySelectorAll('button')).find(isSubmitOrContinue);
            if (!submitBtn) return { ok: false, error: 'Submit button not found' };

            const card = submitBtn.closest('div[class*="rounded-"], div[class*="border"], [role="dialog"], .modal') 
                || submitBtn.parentElement?.parentElement;
            if (!card) return { ok: false, error: 'Card not found' };

            const optionElements = Array.from(card.querySelectorAll('label, div[role="radio"], div[role="checkbox"], div[class*="option"], div[class*="choice"]'))
                .filter(el => {
                    const inputEl = el.querySelector('textarea, input');
                    let txt = '';
                    if (inputEl) {
                        txt = (inputEl.placeholder || inputEl.getAttribute('placeholder') || '').trim();
                    }
                    if (!txt) {
                        txt = (el.textContent || '').trim();
                    }
                    return txt.length > 0 && txt.length < 200 
                        && !txt.toLowerCase().includes('submit') 
                        && !txt.toLowerCase().includes('skip');
                });

            const seenTexts = new Set();
            const cleanOptionElements = [];
            for (const el of optionElements) {
                const inputEl = el.querySelector('textarea, input');
                let txt = '';
                if (inputEl) {
                    txt = (inputEl.placeholder || inputEl.getAttribute('placeholder') || '').trim();
                }
                if (!txt) {
                    txt = el.textContent.trim();
                }
                txt = txt.replace(/^\\s*\\d+[\\s.)]*/, '');
                if (txt && !seenTexts.has(txt)) {
                    seenTexts.add(txt);
                    cleanOptionElements.push(el);
                }
            }

            if (cleanOptionElements.length === 0) {
                const divs = Array.from(card.querySelectorAll('div'))
                    .filter(d => d.children.length === 0 && d.textContent.trim().length > 0);
                for (const d of divs) {
                    const txt = d.textContent.trim().replace(/^\\s*\\d+[\\s.)]*/, '');
                    if (txt.length > 0 && txt.length < 250 
                        && !txt.toLowerCase().includes('submit') 
                        && !txt.toLowerCase().includes('skip')) {
                        if (!seenTexts.has(txt)) {
                            seenTexts.add(txt);
                            cleanOptionElements.push(d);
                        }
                    }
                }
            }

            const target = cleanOptionElements[${optionIndex}];
            if (target && typeof target.click === 'function') {
                target.click();
                return { ok: true };
            }
            return { ok: false, error: 'Option element not found at index ' + ${optionIndex} };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    })()`,

    buildSubmitQuestionTextScript: (optionIndex: number, text: string) => `(() => {
        try {
            const isSubmitOrContinue = (btn) => {
                const t = (btn.textContent || '').trim().toLowerCase();
                return t.includes('submit') || t.includes('continue');
            };
            const submitBtn = Array.from(document.querySelectorAll('button')).find(isSubmitOrContinue);
            if (!submitBtn) return { ok: false, error: 'Submit button not found' };

            const card = submitBtn.closest('div[class*="rounded-"], div[class*="border"], [role="dialog"], .modal') 
                || submitBtn.parentElement?.parentElement;
            if (!card) return { ok: false, error: 'Card not found' };

            const optionElements = Array.from(card.querySelectorAll('label, div[role="radio"], div[role="checkbox"], div[class*="option"], div[class*="choice"]'))
                .filter(el => {
                    const inputEl = el.querySelector('textarea, input');
                    let txt = '';
                    if (inputEl) {
                        txt = (inputEl.placeholder || inputEl.getAttribute('placeholder') || '').trim();
                    }
                    if (!txt) {
                        txt = (el.textContent || '').trim();
                    }
                    return txt.length > 0 && txt.length < 200 
                        && !txt.toLowerCase().includes('submit') 
                        && !txt.toLowerCase().includes('skip');
                });

            const seenTexts = new Set();
            const cleanOptionElements = [];
            for (const el of optionElements) {
                const inputEl = el.querySelector('textarea, input');
                let txt = '';
                if (inputEl) {
                    txt = (inputEl.placeholder || inputEl.getAttribute('placeholder') || '').trim();
                }
                if (!txt) {
                    txt = el.textContent.trim();
                }
                txt = txt.replace(/^\\s*\\d+[\\s.)]*/, '');
                if (txt && !seenTexts.has(txt)) {
                    seenTexts.add(txt);
                    cleanOptionElements.push(el);
                }
            }

            if (cleanOptionElements.length === 0) {
                const divs = Array.from(card.querySelectorAll('div'))
                    .filter(d => d.children.length === 0 && d.textContent.trim().length > 0);
                for (const d of divs) {
                    const txt = d.textContent.trim().replace(/^\\s*\\d+[\\s.)]*/, '');
                    if (txt.length > 0 && txt.length < 250 
                        && !txt.toLowerCase().includes('submit') 
                        && !txt.toLowerCase().includes('skip')) {
                        if (!seenTexts.has(txt)) {
                            seenTexts.add(txt);
                            cleanOptionElements.push(d);
                        }
                    }
                }
            }

            const target = cleanOptionElements[${optionIndex}];
            if (target && typeof target.click === 'function') {
                target.click();
            }

            const inputEl = card.querySelector('textarea, input[type="text"]');
            if (!inputEl) return { ok: false, error: 'Textarea or text input not found' };

            inputEl.value = ${JSON.stringify(text)};
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            submitBtn.click();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    })()`,

    SUBMIT_QUESTION_SCRIPT: `(() => {
        try {
            const isSubmitOrContinue = (btn) => {
                const t = (btn.textContent || '').trim().toLowerCase();
                return t.includes('submit') || t.includes('continue');
            };
            const submitBtn = Array.from(document.querySelectorAll('button')).find(isSubmitOrContinue);
            if (submitBtn && typeof submitBtn.click === 'function') {
                submitBtn.click();
                return { ok: true };
            }
            return { ok: false, error: 'Submit button not found' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    })()`,

    SKIP_QUESTION_SCRIPT: `(() => {
        try {
            const isSubmitOrContinue = (btn) => {
                const t = (btn.textContent || '').trim().toLowerCase();
                return t.includes('submit') || t.includes('continue');
            };
            const submitBtn = Array.from(document.querySelectorAll('button')).find(isSubmitOrContinue);
            if (!submitBtn) return { ok: false, error: 'Submit button not found' };

            const card = submitBtn.closest('div[class*="rounded-"], div[class*="border"], [role="dialog"], .modal') 
                || submitBtn.parentElement?.parentElement;
            if (!card) return { ok: false, error: 'Card not found' };

            const skipBtn = Array.from(card.querySelectorAll('button, span, a'))
                .find(el => (el.textContent || '').trim().toLowerCase() === 'skip');
            if (skipBtn && typeof skipBtn.click === 'function') {
                skipBtn.click();
                return { ok: true };
            }
            return { ok: false, error: 'Skip button not found' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    })()`,
};

