const http = require('http');
const WebSocket = require('ws');

const CHECK_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;
    const submitBtn = Array.from(scope.querySelectorAll('button')).find(btn => {
        const rect = btn.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        if (!isVisible) return false;
        const t = (btn.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        return t === 'submit' || t.startsWith('submit');
    });
    return !!submitBtn;
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
                        expression: CHECK_SCRIPT,
                        returnByValue: true
                    }
                }));
            });
            ws.on('message', (msg) => {
                const packet = JSON.parse(msg.toString());
                if (packet.id === 1) {
                    console.log('Dialog still open:', packet.result?.result?.value);
                    ws.close();
                }
            });
        } catch (e) {
            console.error(e);
        }
    });
});
