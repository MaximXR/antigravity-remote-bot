const http = require('http');
const WebSocket = require('ws');

// The DETECT_APPROVAL_SCRIPT from approvalDetector.ts
const DETECT_APPROVAL_SCRIPT = `(() => {
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

    const normalize = (text) => (text || '').toLowerCase().replace(/\\\\s+/g, ' ').trim();
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
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
        const container = submitBtn.closest('[role=\"dialog\"], .modal, .dialog, .approval-container, .permission-dialog, div[class*=\"rounded-2xl\"], div[class*=\"rounded-lg\"], div[class*=\"border\"]') || scope;
        const options = Array.from(container.querySelectorAll('label, button, [role=\"button\"], .cursor-pointer'))
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
                return t === p || t.includes(p);
            });
        });

        if (allowOnceOpt && denyOpt) {
            let description = '';
            const headerEl = container.querySelector('span.text-sm.font-medium.text-foreground, h3, h2, p, .text-sm.font-medium');
            if (headerEl) {
                description = (headerEl.textContent || '').trim();
            }
            if (!description) description = 'Allow request';

            const approveText = (allowOnceOpt.textContent || '').trim();
            const alwaysAllowText = alwaysOpt ? (alwaysOpt.textContent || '').trim() : '';
            const denyText = (denyOpt.textContent || '').trim();

            return { approveText, alwaysAllowText, denyText, description, strategy: 1 };
        }
    }

    return { foundSubmit: !!submitBtn, msg: 'Strategy 1 not matched' };
})()`;

http.get('http://127.0.0.1:9223/json', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const list = JSON.parse(data);
            const workbench = list.find(t => t.url && t.url.includes('workbench'));
            if (!workbench) {
                console.log('No workbench found.');
                return;
            }
            const ws = new WebSocket(workbench.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: DETECT_APPROVAL_SCRIPT,
                        returnByValue: true
                    }
                }));
            });
            ws.on('message', (msg) => {
                const packet = JSON.parse(msg.toString());
                if (packet.id === 1) {
                    console.log('Detection result:', packet.result?.result?.value);
                    ws.close();
                }
            });
        } catch (e) {
            console.error(e);
        }
    });
});
