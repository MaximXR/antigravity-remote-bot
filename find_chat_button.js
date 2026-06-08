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

const findChatScript = `(() => {
    const isVisible = (el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const serializeEl = (el) => {
        const rect = el.getBoundingClientRect();
        return {
            tagName: el.tagName,
            className: el.className,
            text: (el.textContent || '').trim().slice(0, 50),
            visible: isVisible(el),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            attributes: Array.from(el.attributes).map(a => ({ name: a.name, value: a.value }))
        };
    };

    const keywords = ['chat', 'cascade', 'agent', 'gemini', 'assistant', 'conversation'];
    const candidates = [];
    
    // Scan all elements
    const elements = Array.from(document.querySelectorAll('a, button, [role="button"], [role="tab"], span, div, i, svg'));
    for (const el of elements) {
        if (!isVisible(el)) continue;
        
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const id = (el.getAttribute('id') || '').toLowerCase();
        const cls = (el.getAttribute('class') || '').toLowerCase();
        const txt = (el.textContent || '').toLowerCase().trim();
        
        const allText = [label, title, id, cls, txt].join(' ');
        if (keywords.some(k => allText.includes(k))) {
            candidates.push(serializeEl(el));
        }
    }
    
    return {
        candidates: candidates.slice(0, 40)
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
        
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        });
        
        ws.on('message', async (data) => {
            const res = JSON.parse(data.toString());
            if (res.method === 'Runtime.executionContextCreated') {
                const contextId = res.params.context.id;
                console.log(`\nEvaluating on Context ${contextId}...`);
                
                const evalRes = await new Promise((resolve) => {
                    const id = 100 + contextId;
                    ws.send(JSON.stringify({
                        id,
                        method: 'Runtime.evaluate',
                        params: { expression: findChatScript, returnByValue: true, contextId }
                    }));
                    
                    const handler = (msg) => {
                        const r = JSON.parse(msg.toString());
                        if (r.id === id) {
                            ws.off('message', handler);
                            resolve(r.result?.result?.value);
                        }
                    };
                    ws.on('message', handler);
                });
                
                console.log(JSON.stringify(evalRes, null, 2));
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
