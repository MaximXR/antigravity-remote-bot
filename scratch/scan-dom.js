const http = require('http');
const WebSocket = require('ws');

const CDP_PORTS = [61390, 61114, 61113, 9222, 9223, 9333, 9444, 9555, 9666];

async function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error(`Timeout fetching ${url}`));
        });
    });
}

async function run() {
    let wsUrl = null;
    for (const port of CDP_PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (target) {
                wsUrl = target.webSocketDebuggerUrl;
                console.log(`Found target on port ${port}:`, target.title);
                break;
            }
        } catch (e) {
            // ignore
        }
    }

    if (!wsUrl) {
        console.error('No CDP target found');
        return;
    }

    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
        console.log('Connected to WebSocket');
        
        // Получаем контексты
        ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.enable'
        }));

        // Выполняем скрипт
        setTimeout(() => {
            const expression = `(() => {
                const results = [];
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], .cursor-pointer'));
                buttons.forEach(btn => {
                    const text = (btn.textContent || '').trim();
                    if (!text || text.length > 50) return;
                    const rect = btn.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return;
                    
                    // Находим родительский класс
                    let parentClasses = '';
                    let parent = btn.parentElement;
                    if (parent) {
                        parentClasses = parent.className;
                    }
                    
                    results.push({
                        text,
                        tagName: btn.tagName,
                        className: btn.className,
                        parentClasses,
                        rect: { width: rect.width, height: rect.height }
                    });
                });
                return results;
            })()`;

            ws.send(JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: {
                    expression,
                    returnByValue: true
                }
            }));
        }, 1000);
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === 2) {
            const value = msg.result?.result?.value;
            console.log('Detected buttons:');
            console.dir(value, { depth: null });
            ws.close();
        }
    });
}

run().catch(console.error);
