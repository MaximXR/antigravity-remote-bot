const fs = require('fs');
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
        const pages = await getJson('http://localhost:9333/json/list');
        const target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl && p.title.includes('Antigravity IDE'));
        if (!target) {
            console.error("No real workbench page found!");
            process.exit(1);
        }
        
        console.log(`Connecting to ${target.title} (${target.webSocketDebuggerUrl})...`);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        
        ws.on('open', () => {
            console.log("Connected! Enabling page and capturing screenshot...");
            ws.send(JSON.stringify({
                id: 1,
                method: 'Page.enable'
            }));
            ws.send(JSON.stringify({
                id: 2,
                method: 'Page.captureScreenshot',
                params: { format: 'png' }
            }));
        });
        
        ws.on('message', (data) => {
            const res = JSON.parse(data.toString());
            if (res.id === 2) {
                if (res.error) {
                    console.error("Screenshot error:", res.error);
                } else {
                    const base64Data = res.result.data;
                    const buffer = Buffer.from(base64Data, 'base64');
                    const outPath = 'C:\\Users\\sss77\\.gemini\\antigravity-ide\\brain\\d896345e-3586-4886-b190-5601d4776e6b\\ide_real_screenshot.png';
                    fs.writeFileSync(outPath, buffer);
                    console.log(`Screenshot saved to ${outPath}`);
                }
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
