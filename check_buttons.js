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

const checkScript = `(() => {
    const elements = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="button"]'));
    return elements.map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim(),
        title: el.getAttribute('title') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        tooltip: el.getAttribute('data-tooltip-content') || '',
        html: el.outerHTML.slice(0, 400)
    }));
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
            const search = await sendCommand('Runtime.evaluate', { expression: checkScript, returnByValue: true });
            const elements = search.result?.result?.value || [];
            
            console.log(`Found ${elements.length} elements:`);
            for (const el of elements) {
                const text = el.text.toLowerCase();
                const title = el.title.toLowerCase();
                const aria = el.ariaLabel.toLowerCase();
                const html = el.html.toLowerCase();
                const tooltip = el.tooltip.toLowerCase();
                
                const keywords = ['undo', 'rollback', 'cancel', 'отмен', 'откат', 'назад', 'шаг'];
                const isCandidate = keywords.some(kw => text.includes(kw) || title.includes(kw) || aria.includes(kw) || html.includes(kw) || tooltip.includes(kw));
                
                if (isCandidate) {
                    console.log("--- CANDIDATE ---");
                    console.log(JSON.stringify(el, null, 2));
                    console.log();
                }
            }
            
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
