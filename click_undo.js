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

const clickScript = `(() => {
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const elements = Array.from(document.querySelectorAll('button, [role="button"]'));
    const undoButtons = [];
    
    for (const el of elements) {
        const text = (el.textContent || '').trim().toLowerCase();
        const title = (el.getAttribute('title') || '').trim().toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const tooltip = (el.getAttribute('data-tooltip-content') || '').trim().toLowerCase();
        const tooltipId = (el.getAttribute('data-tooltip-id') || '').trim().toLowerCase();
        const html = el.outerHTML.toLowerCase();
        
        const isUndo = text.includes('undo') || 
                       title.includes('undo') || 
                       ariaLabel.includes('undo') || 
                       tooltip.includes('undo') || 
                       tooltipId.includes('undo') ||
                       html.includes('undo');
                       
        if (isUndo) {
            undoButtons.push(el);
        }
    }
    
    if (undoButtons.length === 0) {
        return { found: false, error: 'No undo buttons found' };
    }
    
    // Pick the last one in the DOM (most recent message)
    const target = undoButtons[undoButtons.length - 1];
    const rect = target.getBoundingClientRect();
    
    return {
        found: true,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        html: target.outerHTML.slice(0, 200)
    };
})()`;

async function run() {
    try {
        const pages = await getJson('http://localhost:9223/json/list');
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
            
            const search = await sendCommand('Runtime.evaluate', { expression: clickScript, returnByValue: true });
            console.log("Raw search response:", JSON.stringify(search, null, 2));
            const val = search.result?.result?.value;
            
            if (val && val.found) {
                console.log(`Clicking undo button at x=${val.x}, y=${val.y}...`);
                // Hover
                await sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: val.x, y: val.y });
                await new Promise(r => setTimeout(r, 100));
                // Press
                await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: val.x, y: val.y, button: 'left', clickCount: 1 });
                // Release
                await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: val.x, y: val.y, button: 'left', clickCount: 1 });
                console.log("Clicked successfully!");
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
