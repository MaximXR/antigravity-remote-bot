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

async function run() {
    try {
        const pages = await getJson('http://localhost:9223/json/list');
        const target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl && p.title.includes('Antigravity IDE'));
        if (!target) {
            console.error("No real workbench page found!");
            process.exit(1);
        }
        
        console.log(`Connecting to ${target.title}...`);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        
        ws.on('open', () => {
            console.log("Connected! Clicking Accept all...");
            const expression = `(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const targetBtn = buttons.find(b => {
                    const text = (b.textContent || '').trim().toLowerCase();
                    return text.includes('accept all') || text === 'accept';
                });
                if (targetBtn) {
                    targetBtn.click();
                    return { ok: true, text: targetBtn.textContent };
                }
                return { ok: false, error: 'Button not found' };
            })()`;
            
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                    expression,
                    returnByValue: true,
                    awaitPromise: true
                }
            }));
        });
        
        ws.on('message', (data) => {
            const res = JSON.parse(data.toString());
            if (res.id === 1) {
                console.log("Result:", res.result?.value);
                ws.close();
                process.exit(0);
            }
        });
        
        ws.on('error', (err) => {
            console.error("WebSocket error:", err);
            process.exit(1);
        });
        
    } catch (e) {
        console.error("Failed:", e);
        process.exit(1);
    }
}

run();
