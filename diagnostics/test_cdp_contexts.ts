import { CdpService } from './src/services/cdpService';
import { logger } from './src/utils/logger';

async function run() {
    logger.setLogLevel('debug');
    const cdpService = new CdpService({ portsToScan: [9333] });
    
    try {
        console.log("Discovering and connecting to Antigravity IDE...");
        await cdpService.connect();
        console.log("Connected successfully! Waiting 1.5 seconds for all contexts to load...");
        
        await new Promise(r => setTimeout(r, 1500));
        
        const contexts = (cdpService as any).contexts || [];
        console.log(`\nDiscovered ${contexts.length} contexts:`);
        for (const ctx of contexts) {
            console.log(`- ID: ${ctx.id} | Name: "${ctx.name}" | URL: "${ctx.url}"`);
        }
        
        console.log("\nSearching for Confirm button in all contexts...");
        const findConfirmScript = `(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const confirmBtn = buttons.find(b => {
                const text = (b.textContent || '').trim().toLowerCase();
                return text === 'confirm' || text === 'confirm undo' || text === 'yes';
            });
            if (confirmBtn) {
                return { found: true, html: confirmBtn.outerHTML };
            }
            return { found: false };
        })()`;
        
        for (const ctx of contexts) {
            try {
                const res = await cdpService.call('Runtime.evaluate', {
                    expression: findConfirmScript,
                    returnByValue: true,
                    contextId: ctx.id
                });
                const val = res?.result?.value;
                if (val && val.found) {
                    console.log(`[FOUND] Confirm button in context ${ctx.id} (${ctx.name})! HTML: ${val.html}`);
                }
            } catch (e: any) {
                console.log(`Error in context ${ctx.id}: ${e.message}`);
            }
        }
        
        await cdpService.disconnect();
        process.exit(0);
    } catch (e: any) {
        console.error("Failed:", e);
        process.exit(1);
    }
}

run();
