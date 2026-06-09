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

const findQuickPickScript = `(() => {
    const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
    const widget = document.querySelector('.quick-input-widget') || document.querySelector('[class*="quick-input"]');
    if (widget && isVisible(widget)) {
        const rows = Array.from(widget.querySelectorAll('.monaco-list-row, [role="option"], [role="button"]'));
        const rowData = rows.map(row => ({
            text: row.textContent,
            isVisible: isVisible(row),
            className: row.className
        }));
        
        for (const row of rows) {
            if (row instanceof HTMLElement && isVisible(row)) {
                const rowText = (row.textContent || '').toLowerCase();
                if (rowText.includes('current window') || rowText.includes('current workspace')) {
                    const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
                    for (const type of events) {
                        row.dispatchEvent(new MouseEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        }));
                    }
                    return { resolved: true, clicked: rowText, foundRows: rowData };
                }
            }
        }
        return { resolved: false, reason: 'No matching row', foundRows: rowData };
    }
    return { resolved: false, reason: 'Widget not found or not visible' };
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
        ws.on('open', () => {
            // Enable Runtime
            ws.send(JSON.stringify({ id: callId++, method: 'Runtime.enable' }));
        });
        
        ws.on('message', async (data) => {
            const res = JSON.parse(data.toString());
            
            // Once Runtime is enabled, we get execution contexts or we can evaluate
            if (res.method === 'Runtime.executionContextCreated') {
                const contextId = res.params.context.id;
                console.log(`Context created: id=${contextId}, name=${res.params.context.name}, origin=${res.params.context.origin}`);
                
                // Evaluate in this context
                ws.send(JSON.stringify({
                    id: 100 + contextId,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: findQuickPickScript,
                        returnByValue: true,
                        contextId: contextId
                    }
                }));
            }
            
            if (res.id && res.id > 100) {
                const ctxId = res.id - 100;
                console.log(`--- Result for Context ${ctxId} ---`);
                console.log(JSON.stringify(res.result?.result?.value, null, 2));
            }
        });
        
        // Wait 3 seconds and close
        setTimeout(() => {
            ws.close();
            console.log("Done.");
            process.exit(0);
        }, 3000);
        
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
