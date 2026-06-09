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

const findConfirmScript = `(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const results = [];
    for (const b of buttons) {
        const text = (b.textContent || '').trim();
        const textLower = text.toLowerCase();
        
        if (textLower === 'confirm' || textLower === 'cancel' || textLower.includes('confirm') || textLower.includes('cancel')) {
            results.push({
                tag: b.tagName,
                text: text,
                html: b.outerHTML.slice(0, 300)
            });
        }
    }
    
    // Also check body inner text
    const hasText = document.body.innerText.includes('Confirm Undo') || document.body.innerText.includes('Confirming this undo');
    
    return {
        url: window.location.href,
        hasText: hasText,
        buttons: results
    };
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
        
        const sessions = new Map();
        
        const sendCommand = (method, params, sessionId = undefined) => {
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
                const msg = JSON.stringify({ id: requestId, method, params, sessionId });
                ws.send(msg);
            });
        };

        ws.on('message', async (data) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.method === 'Target.attachedToTarget') {
                const sessionInfo = msg.params;
                const { sessionId, targetInfo } = sessionInfo;
                console.log(`[ATTACHED] Target ID: ${targetInfo.targetId} | Type: ${targetInfo.type} | URL: ${targetInfo.url}`);
                sessions.set(sessionId, targetInfo);
                
                // Query this target for the Confirm button
                try {
                    // We must first enable Runtime in this session
                    await sendCommand('Runtime.enable', {}, sessionId);
                    
                    const res = await sendCommand('Runtime.evaluate', {
                        expression: findConfirmScript,
                        returnByValue: true
                    }, sessionId);
                    
                    const val = res.result?.result?.value;
                    if (val) {
                        console.log(`[SESSION ${sessionId}] URL: ${val.url}`);
                        console.log(`  - Has text: ${val.hasText}`);
                        console.log(`  - Buttons found:`, JSON.stringify(val.buttons, null, 2));
                    }
                } catch (e) {
                    console.log(`Error evaluating in session ${sessionId}:`, e.message);
                }
            }
        });

        ws.on('open', async () => {
            console.log("Connected to main workbench. Enabling Target domain...");
            await sendCommand('Target.setAutoAttach', {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true
            });
            
            console.log("Listening for attached targets for 2 seconds...");
            await new Promise(r => setTimeout(r, 2000));
            
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
