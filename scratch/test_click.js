const http = require('http');
const WebSocket = require('ws');

// The click script from buildClickScript('1Yes, allow this time')
const CLICK_SCRIPT = `(() => {
    const normalize = (text) => (text || '').toLowerCase().replace(/\\\\s+/g, ' ').trim();
    const text = "1Yes, allow this time";
    const wanted = normalize(text);
    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;
    const allClickables = Array.from(scope.querySelectorAll('button, [role=\"button\"], .cursor-pointer, label'))
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
    
    console.log('Found click target:', target.tagName, target.textContent);
    target.click();

    const radio = target.querySelector('input[type=\"radio\"], input[type=\"checkbox\"]');
    if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const container = target.closest('[role=\"dialog\"], .modal, .dialog, .approval-container, .permission-dialog, div[class*=\"rounded-2xl\"], div[class*=\"rounded-lg\"], div[class*=\"border\"]')
        || target.parentElement?.parentElement
        || target.parentElement;
        
    console.log('Container found:', !!container, container ? container.className : '');
    
    if (container) {
        const submitBtn = Array.from(container.querySelectorAll('button')).find(btn => {
            const t = normalize(btn.textContent || '');
            return t === 'submit' || t.startsWith('submit');
        });
        console.log('Submit button found:', !!submitBtn, submitBtn ? submitBtn.textContent : '');
        if (submitBtn) {
            submitBtn.click();
            return { ok: true, submitted: true };
        }
    }
    return { ok: true, msg: 'No submit button clicked' };
})()`;

http.get('http://127.0.0.1:9223/json', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const list = JSON.parse(data);
            const workbench = list.find(t => t.url && t.url.includes('workbench'));
            const ws = new WebSocket(workbench.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: CLICK_SCRIPT,
                        returnByValue: true
                    }
                }));
            });
            ws.on('message', (msg) => {
                const packet = JSON.parse(msg.toString());
                if (packet.id === 1) {
                    console.log('Click script output:', packet.result?.result?.value);
                    ws.close();
                }
            });
        } catch (e) {
            console.error(e);
        }
    });
});
