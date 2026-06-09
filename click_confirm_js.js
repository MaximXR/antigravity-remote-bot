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

const confirmScript = `(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const confirmBtn = buttons.find(b => {
        const text = (b.textContent || '').trim().toLowerCase();
        return text === 'confirm' || text === 'confirm undo' || text === 'yes';
    });
    if (confirmBtn) {
        confirmBtn.click();
        return { clicked: true, html: confirmBtn.outerHTML };
    }
    return { clicked: false, error: 'Confirm button not found' };
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
            const res = await sendCommand('Runtime.evaluate', { expression: confirmScript, returnByValue: true });
            console.log("Confirm click result:", res.result?.result?.value);
            
            await new Promise(r => setTimeout(r, 500));
            
            // Capture screenshot
            await sendCommand('Page.enable');
            const screenshotRes = await sendCommand('Page.captureScreenshot', { format: 'png' });
            const base64Data = screenshotRes.result.data;
            const buffer = Buffer.from(base64Data, 'base64');
            const outPath = 'C:\\Users\\sss77\\.gemini\\antigravity-ide\\brain\\d896345e-3586-4886-b190-5601d4776e6b\\ide_real_screenshot.png';
            fs.writeFileSync(outPath, buffer);
            console.log(`Screenshot saved to ${outPath}`);
            
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
