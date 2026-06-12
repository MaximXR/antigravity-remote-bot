const Database = require('better-sqlite3');
const WebSocket = require('ws');
// @ts-ignore
const fetch = require('node-fetch');

async function main() {
    // 1. Get targets on port 9223
    const resp = await fetch('http://127.0.0.1:9223/json');
    const targets = await resp.json();
    const target = targets.find(t => t.title.includes('Desktop') && t.type === 'page');
    if (!target) {
        console.error('Target "Desktop" not found!');
        return;
    }
    console.log('Connecting to target:', target.title, 'URL:', target.webSocketDebuggerUrl);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.once('open', resolve));

    let msgId = 1;
    function call(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = msgId++;
            const payload = JSON.stringify({ id, method, params });
            const handler = (data) => {
                const parsed = JSON.parse(data);
                if (parsed.id === id) {
                    ws.removeListener('message', handler);
                    if (parsed.error) reject(parsed.error);
                    else resolve(parsed.result);
                }
            };
            ws.on('message', handler);
            ws.send(payload);
        });
    }

    // Enable Runtime
    await call('Runtime.enable');

    const APPROVAL_SELECTORS = {
        DETECT_APPROVAL_SCRIPT: `(() => {
        try {
            const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', 'allow this time', '今回のみ許可', '1回のみ許可', '一度许可'];
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
                return !!el.closest('.statusbar, [class*="statusbar"], .titlebar, [class*="titlebar"], .activitybar, [class*="activitybar"]');
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

            const allClickables = Array.from(scope.querySelectorAll('button, [role="button"], a.monaco-button'))
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

            if (!approveBtn) return { error: 'no approveBtn' };

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

            if (!denyBtn) return { error: 'no denyBtn', containerTagName: container.tagName, containerClassName: container.className, clickables: containerClickables.map(b => b.textContent) };

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
        } catch (e) {
            return { error: 'exception', message: e.message };
        }
    })()`,
    };

    const result = await call('Runtime.evaluate', { expression: APPROVAL_SELECTORS.DETECT_APPROVAL_SCRIPT, returnByValue: true });
    console.log('Result:', result.result.value);

    ws.close();
}

main().catch(console.error);
