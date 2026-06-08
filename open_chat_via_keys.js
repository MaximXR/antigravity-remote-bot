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

const checkPanelScript = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel, [class*="side-panel"], [class*="agent-panel"]');
    return {
        found: !!panel,
        html: panel ? panel.outerHTML.slice(0, 300) : null,
        documentTitle: document.title
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
            console.log("Connected! Enabling Runtime...");
            await sendCommand('Runtime.enable');
            
            // Check if panel is already open
            let check = await sendCommand('Runtime.evaluate', { expression: checkPanelScript, returnByValue: true });
            console.log("Initial check:", check.result?.result?.value);
            
            if (check.result?.result?.value?.found) {
                console.log("Panel already open!");
                ws.close();
                process.exit(0);
            }
            
            // Try Ctrl+Alt+J
            console.log("Sending Ctrl+Alt+J...");
            // Ctrl: modifier = 2, Alt: modifier = 1. Together = 3.
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 3 });
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74, modifiers: 3 });
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74, modifiers: 3 });
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 2 });
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
            
            await new Promise(r => setTimeout(r, 1000));
            
            check = await sendCommand('Runtime.evaluate', { expression: checkPanelScript, returnByValue: true });
            console.log("Check after Ctrl+Alt+J:", check.result?.result?.value);
            
            if (!check.result?.result?.value?.found) {
                // Try Ctrl+Alt+G
                console.log("Sending Ctrl+Alt+G...");
                await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
                await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 3 });
                await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71, modifiers: 3 });
                await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71, modifiers: 3 });
                await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 2 });
                await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
                
                await new Promise(r => setTimeout(r, 1000));
                check = await sendCommand('Runtime.evaluate', { expression: checkPanelScript, returnByValue: true });
                console.log("Check after Ctrl+Alt+G:", check.result?.result?.value);
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
