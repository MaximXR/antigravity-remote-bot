const http = require('http');
const WebSocket = require('ws');

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

const findScript = `(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const results = [];
    for (const el of all) {
        const text = (el.textContent || '').trim();
        const textLower = text.toLowerCase();
        
        // Skip editor file items
        if (/\\.(ts|js|py|txt|json|md|html|css|bat|sh)/i.test(text)) {
            continue;
        }
        
        if (textLower.includes('confirm') || textLower === 'yes' || textLower === 'cancel' || textLower.includes('отмена')) {
            // Only take elements that are relatively small to avoid printing the whole body
            if (el.outerHTML.length < 1000) {
                const rect = el.getBoundingClientRect();
                results.push({
                    tag: el.tagName,
                    text: text.slice(0, 100),
                    className: el.className || '',
                    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                    html: el.outerHTML.slice(0, 300)
                });
            }
        }
    }
    return results;
})()`;

async function run() {
    try {
        const pages = await getJson('http://localhost:9333/json/list');
        const target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl && p.title.includes('Antigravity IDE'));
        if (!target) {
            console.error("No real workbench page found!");
            process.exit(1);
        }
        
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        
        const sendCommand = (method, params) => {
            return new Promise((resolve) => {
                const requestId = Math.floor(Math.random() * 100000);
                const onMessage = (data) => {
                    const res = JSON.parse(data.toString());
                    if (res.id === requestId) {
                        ws.off('message', onMessage);
                        resolve(res);
                    }
                };
                ws.on('message', onMessage);
                const msg = JSON.stringify({ id: requestId, method, params });
                ws.send(msg);
            });
        };

        ws.on('open', async () => {
            await sendCommand('Runtime.enable');
            const res = await sendCommand('Runtime.evaluate', { expression: findScript, returnByValue: true });
            console.log("Matching elements:", JSON.stringify(res.result?.result?.value, null, 2));
            ws.close();
            process.exit(0);
        });
        ws.on('error', err => { console.error(err); process.exit(1); });
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
