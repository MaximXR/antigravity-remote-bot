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
    const info = [];
    const elements = Array.from(document.querySelectorAll('button, [role="button"], svg, path, div, span'));
    
    for (const el of elements) {
        const text = (el.textContent || '').trim().toLowerCase();
        const title = (el.getAttribute('title') || '').trim().toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const tooltip = (el.getAttribute('data-tooltip-content') || '').trim().toLowerCase();
        const tooltipId = (el.getAttribute('data-tooltip-id') || '').trim().toLowerCase();
        const cls = (el.className || '');
        
        const isUndo = text.includes('undo') || 
                       title.includes('undo') || 
                       ariaLabel.includes('undo') || 
                       tooltip.includes('undo') || 
                       tooltipId.includes('undo') ||
                       (typeof cls === 'string' && cls.toLowerCase().includes('undo'));
                       
        if (isUndo) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width <= 60 && rect.height > 0 && rect.height <= 60) {
                const messageParent = el.closest('[data-message-author-role], [data-message-role], [class*="message"]');
                info.push({
                    tagName: el.tagName,
                    className: cls,
                    text: text.slice(0, 50),
                    title: el.getAttribute('title'),
                    ariaLabel: el.getAttribute('aria-label'),
                    tooltip: el.getAttribute('data-tooltip-content'),
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    messageText: messageParent ? messageParent.innerText.slice(0, 100) : null
                });
            }
        }
    }
    return info;
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
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: checkScript, returnByValue: true }
            }));
        });
        ws.on('message', (data) => {
            const res = JSON.parse(data.toString());
            if (res.id === 1) {
                const fs = require('fs');
                fs.writeFileSync('undo_elements.json', JSON.stringify(res.result.result.value, null, 2));
                console.log("Results written to undo_elements.json");
                ws.close();
                process.exit(0);
            }
        });
        ws.on('error', err => { console.error(err); process.exit(1); });
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
