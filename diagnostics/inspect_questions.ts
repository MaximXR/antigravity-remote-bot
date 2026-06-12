import { CdpService } from '../src/services/cdpService';
import { logger } from '../src/utils/logger';
import http from 'http';

function getJson(url: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
    });
}

async function run() {
    logger.setLogLevel('debug');
    try {
        console.log("Fetching pages from port 9223...");
        const pages = await getJson("http://127.0.0.1:9223/json/list");
        const workbenchPages = pages.filter((t: any) => 
            t.type === 'page' && 
            t.webSocketDebuggerUrl && 
            t.url?.includes('workbench') &&
            !t.title?.includes('Launchpad')
        );
        
        console.log(`Found ${workbenchPages.length} workbench pages.`);
        
        const inspectScript = `(() => {
            try {
                // Find all elements containing text or inputs
                const buttons = Array.from(document.querySelectorAll('button, span, a'))
                    .filter(el => {
                        const text = (el.textContent || '').trim().toLowerCase();
                        return text === 'submit' || text === 'skip';
                    })
                    .map(el => ({
                        tagName: el.tagName,
                        className: el.className,
                        text: el.textContent.trim(),
                        outerHTML: el.outerHTML
                    }));

                // Look for text "Как лучше" or options
                const textNodes = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node;
                while (node = walker.nextNode()) {
                    const txt = node.textContent.trim();
                    if (txt.includes('Как лучше') || txt.includes('сканирования') || txt.includes('Other (write') || txt.includes('Recommended')) {
                        textNodes.push({
                            parentTag: node.parentElement.tagName,
                            parentClass: node.parentElement.className,
                            text: txt
                        });
                    }
                }

                // Look for radio/checkbox inputs
                const inputs = Array.from(document.querySelectorAll('input, select, textarea, div[role="radio"], div[role="checkbox"]'))
                    .map(el => ({
                        tagName: el.tagName,
                        type: el.getAttribute('type'),
                        role: el.getAttribute('role'),
                        className: el.className,
                        value: el.value || el.textContent.trim()
                    }));

                // Dump outer HTML of the first card if found
                const submitBtn = Array.from(document.querySelectorAll('button'))
                    .find(btn => (btn.textContent || '').trim().toLowerCase() === 'submit');

                let cardHTML = null;
                if (submitBtn) {
                    const card = submitBtn.closest('div[class*="rounded-"], div[class*="border"], [role="dialog"], .modal') || submitBtn.parentElement?.parentElement;
                    if (card) {
                        cardHTML = card.outerHTML;
                    }
                }

                return {
                    ok: buttons.length > 0 || textNodes.length > 0,
                    buttons,
                    matchingTextNodes: textNodes,
                    inputs,
                    cardHTML
                };
            } catch (e) {
                return { error: e.message };
            }
        })()`;

        for (const page of workbenchPages) {
            console.log(`\n======================================================`);
            console.log(`Connecting to page: "${page.title}"`);
            console.log(`======================================================`);
            
            const cdpService = new CdpService({ portsToScan: [9223] });
            (cdpService as any).targetUrl = page.webSocketDebuggerUrl;
            await cdpService.connect();
            
            await new Promise(r => setTimeout(r, 1000));
            const contexts = (cdpService as any).contexts || [];
            console.log(`Found ${contexts.length} contexts on page.`);
            
            for (const ctx of contexts) {
                try {
                    const res = await cdpService.call('Runtime.evaluate', {
                        expression: inspectScript,
                        returnByValue: true,
                        contextId: ctx.id
                    });
                    const val = res?.result?.value;
                    if (val && val.ok) {
                        console.log(`\nContext ${ctx.id} ("${ctx.name}") Result:`);
                        console.log(`  Buttons:`, val.buttons);
                        console.log(`  Matching Texts:`, val.matchingTextNodes);
                        console.log(`  Inputs:`, val.inputs);
                        if (val.cardHTML) {
                            console.log(`  Card HTML:\n`, val.cardHTML);
                        }
                    }
                } catch (e: any) {
                    console.log(`  Error in context ${ctx.id}: ${e.message}`);
                }
            }
            
            await cdpService.disconnect();
        }
        
        process.exit(0);
    } catch (e: any) {
        console.error("Failed:", e);
        process.exit(1);
    }
}

run();
