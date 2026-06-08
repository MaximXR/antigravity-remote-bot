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

const findCoordsScript = `(() => {
    const isVisible = (el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    
    const widget = document.querySelector('.quick-input-widget') || document.querySelector('[class*="quick-input"]');
    if (!widget || !isVisible(widget)) return { found: false, reason: 'No visible widget' };
    
    const rows = Array.from(widget.querySelectorAll('.monaco-list-row, [role="option"], [role="button"]'));
    for (const row of rows) {
        if (row instanceof HTMLElement && isVisible(row)) {
            const rowText = (row.textContent || '').toLowerCase();
            if (rowText.includes('current window') || rowText.includes('current workspace')) {
                const rect = row.getBoundingClientRect();
                return {
                    found: true,
                    text: rowText,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2)
                };
            }
        }
    }
    return { found: false, reason: 'No matching row found' };
})()`;

async function run() {
    try {
        const pages = await getJson('http://localhost:9222/json/list');
        const target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl && p.title.includes('Antigravity IDE'));
        if (!target) {
            console.error("No real workbench page found!");
            process.exit(1);
        }
        
        console.log(`Connecting to page: ${target.title}`);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        
        let callId = 1;
        
        const sendCommand = (method, params) => {
            return new Promise((resolve) => {
                const id = callId++;
                const msg = JSON.stringify({ id, method, params });
                ws.send(msg);
                
                const handler = (data) => {
                    const res = JSON.parse(data.toString());
                    if (res.id === id) {
                        ws.off('message', handler);
                        resolve(res);
                    }
                };
                ws.on('message', handler);
            });
        };

        ws.on('open', async () => {
            console.log("Connected! Enabling Runtime...");
            await sendCommand('Runtime.enable');
            
            // Get contexts
            console.log("Waiting a bit for contexts...");
            // Let's evaluate findCoordsScript on all contexts (usually context 7 or similar)
            // We can just evaluate on a list of contexts. We'll search for it:
            // Since we can't easily list contexts directly without listening to Runtime.executionContextCreated,
            // we can just send execution calls if we know the context ID. Or we can wait a bit to collect them.
        });
        
        ws.on('message', async (data) => {
            const res = JSON.parse(data.toString());
            if (res.method === 'Runtime.executionContextCreated') {
                const contextId = res.params.context.id;
                console.log(`Evaluating on Context ${contextId}...`);
                const evalRes = await sendCommand('Runtime.evaluate', {
                    expression: findCoordsScript,
                    returnByValue: true,
                    contextId
                });
                
                const val = evalRes.result?.result?.value;
                if (val && val.found) {
                    console.log(`Found row "${val.text}" at coords: x=${val.x}, y=${val.y} in context ${contextId}`);
                    
                    // Click using CDP Input events
                    console.log("Sending mouse move and click events via CDP...");
                    await sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: val.x, y: val.y });
                    await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: val.x, y: val.y, button: 'left', clickCount: 1 });
                    await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: val.x, y: val.y, button: 'left', clickCount: 1 });
                    
                    console.log("Click sent!");
                    
                    setTimeout(() => {
                        ws.close();
                        console.log("Done.");
                        process.exit(0);
                    }, 1000);
                } else {
                    console.log(`Context ${contextId} result:`, val);
                }
            }
        });
        
        setTimeout(() => {
            ws.close();
            console.log("Timeout.");
            process.exit(0);
        }, 5000);
        
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
