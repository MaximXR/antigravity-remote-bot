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
        const pages = await getJson('http://localhost:9222/json/list');
        const target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl && p.title.includes('Antigravity IDE'));
        if (!target) {
            console.error("No real workbench page found!");
            process.exit(1);
        }
        
        console.log(`Connecting to ${target.title}...`);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        
        const sendCommand = (method, params) => {
            return new Promise((resolve) => {
                const msg = JSON.stringify({ id: Math.floor(Math.random() * 10000), method, params });
                ws.send(msg);
                ws.once('message', (data) => {
                    resolve(JSON.parse(data.toString()));
                });
            });
        };

        ws.on('open', async () => {
            console.log("Connected! Clicking Cockpit (x=21, y=308)...");
            await sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 21, y: 308 });
            await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 21, y: 308, button: 'left', clickCount: 1 });
            await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 21, y: 308, button: 'left', clickCount: 1 });
            
            console.log("Waiting 1.5 seconds...");
            await new Promise(r => setTimeout(r, 1500));
            
            console.log("Enabling page and taking screenshot...");
            await sendCommand('Page.enable');
            const res = await sendCommand('Page.captureScreenshot', { format: 'png' });
            
            if (res.result && res.result.data) {
                const buffer = Buffer.from(res.result.data, 'base64');
                const outPath = 'C:\\Users\\sss77\\.gemini\\antigravity-ide\\brain\\d896345e-3586-4886-b190-5601d4776e6b\\ide_real_screenshot.png';
                fs.writeFileSync(outPath, buffer);
                console.log(`Screenshot saved to ${outPath}`);
            } else {
                console.error("Screenshot failed:", res);
            }
            
            ws.close();
            process.exit(0);
        });
        
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
