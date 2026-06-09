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

const findAndScrollScript = `(() => {
    const elements = Array.from(document.querySelectorAll('button[data-testid="revert-button"], [role="button"][data-testid="revert-button"]'));
    if (elements.length === 0) {
        return { found: false, error: 'No revert buttons found' };
    }
    
    // Pick the last one (most recent)
    const target = elements[elements.length - 1];
    
    // Scroll it into view to make sure it's visible and has positive coordinates
    target.scrollIntoView({ block: 'center', inline: 'center' });
    
    return { found: true };
})()`;

const getCoordsScript = `(() => {
    const elements = Array.from(document.querySelectorAll('button[data-testid="revert-button"], [role="button"][data-testid="revert-button"]'));
    if (elements.length === 0) return null;
    const target = elements[elements.length - 1];
    const rect = target.getBoundingClientRect();
    return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        width: rect.width,
        height: rect.height,
        html: target.outerHTML.slice(0, 300)
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
            
            // 1. Scroll last revert-button into view
            console.log("Scrolling last revert button into view...");
            const scrollRes = await sendCommand('Runtime.evaluate', { expression: findAndScrollScript, returnByValue: true });
            console.log("Scroll result:", scrollRes.result?.result?.value);
            
            await new Promise(r => setTimeout(r, 200));
            
            // 2. Get coords
            const coordsRes = await sendCommand('Runtime.evaluate', { expression: getCoordsScript, returnByValue: true });
            const coords = coordsRes.result?.result?.value;
            console.log("Coords:", coords);
            
            if (coords && coords.x > 0 && coords.y > 0) {
                console.log(`Clicking revert button at x=${coords.x}, y=${coords.y}...`);
                // Move mouse
                await sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y });
                await new Promise(r => setTimeout(r, 100));
                // Press
                await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
                // Release
                await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
                console.log("Clicked! Waiting for modal...");
                
                await new Promise(r => setTimeout(r, 500));
                
                // Capture screenshot to verify
                await sendCommand('Page.enable');
                const screenshotRes = await sendCommand('Page.captureScreenshot', { format: 'png' });
                const base64Data = screenshotRes.result.data;
                const buffer = Buffer.from(base64Data, 'base64');
                const outPath = 'C:\\Users\\sss77\\.gemini\\antigravity-ide\\brain\\d896345e-3586-4886-b190-5601d4776e6b\\ide_real_screenshot.png';
                fs.writeFileSync(outPath, buffer);
                console.log(`Screenshot saved to ${outPath}`);
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
