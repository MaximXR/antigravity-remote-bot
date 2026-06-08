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

const dumpScript = `(() => {
    const isVisible = (el) => {
        if (!el || !(el instanceof HTMLElement)) return 'not_html';
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            offsetParent: !!el.offsetParent
        };
    };
    
    const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
    if (widgets.length === 0) return { found: false, reason: 'No widget elements found' };
    
    const results = widgets.map((widget, wIdx) => {
        const titleEl = widget.querySelector('.quick-input-title');
        const title = titleEl ? titleEl.textContent : '';
        const inputEl = widget.querySelector('.quick-input-filter input');
        const placeholder = inputEl ? inputEl.getAttribute('placeholder') : '';
        const value = inputEl ? inputEl.value : '';
        
        const rows = Array.from(widget.querySelectorAll('.monaco-list-row, [role="option"], [role="button"]'));
        const rowData = rows.map((row, idx) => {
            const labelEl = row.querySelector('.label-name') || row.querySelector('.quick-input-list-label') || row;
            const descEl = row.querySelector('.label-description') || row.querySelector('.quick-input-list-description');
            return {
                index: idx,
                text: row.textContent,
                label: labelEl ? labelEl.textContent : '',
                description: descEl ? descEl.textContent : '',
                isVisible: isVisible(row),
                className: row.className,
                focused: row.classList.contains('focused') || row.getAttribute('aria-selected') === 'true'
            };
        });
        
        return {
            widgetIndex: wIdx,
            isVisible: isVisible(widget),
            title,
            placeholder,
            value,
            rows: rowData
        };
    });
    
    return {
        found: true,
        widgets: results
    };
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
            ws.send(JSON.stringify({ id: callId++, method: 'Runtime.enable' }));
        });
        
        ws.on('message', async (data) => {
            const res = JSON.parse(data.toString());
            
            if (res.method === 'Runtime.executionContextCreated') {
                const contextId = res.params.context.id;
                
                ws.send(JSON.stringify({
                    id: 100 + contextId,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: dumpScript,
                        returnByValue: true,
                        contextId: contextId
                    }
                }));
            }
            
            if (res.id && res.id > 100) {
                const ctxId = res.id - 100;
                const val = res.result?.result?.value;
                if (val && val.found) {
                    console.log(`\n=== Found QuickPick in Context ${ctxId} ===`);
                    console.log(JSON.stringify(val, null, 2));
                }
            }
        });
        
        setTimeout(() => {
            ws.close();
            console.log("\nDone.");
            process.exit(0);
        }, 2000);
        
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
