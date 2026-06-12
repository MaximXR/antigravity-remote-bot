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
        
        const findConfirmScript = `(() => {
            try {
                const ALLOW_ONCE_PATTERNS = ['allow once', 'allow one time', 'allow this time', '今回のみ許可', '1回のみ許可', '一度許可'];
                const ALWAYS_ALLOW_PATTERNS = ['allow this conversation', 'allow this chat', 'always allow', '常に許可', 'この会話を許可'];
                const ALLOW_PATTERNS = ['allow', 'permit', 'run', 'execute', 'accept', 'approve', '許可', '承認', '確認', '実行'];
                const DENY_PATTERNS = ['deny', 'reject', 'no', 'no (tell', '拒否', 'decline', '却下'];

                const normalize = (text) => (text || '').toLowerCase().replace(/^\\s*\\d+[\\s.)]*/, '').replace(/\\s+/g, ' ').trim();
                const isVisible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden';
                };

                const isExcluded = (el) => {
                    if (!el) return true;
                    return !!el.closest('.statusbar, [class*="statusbar"], .titlebar, [class*="titlebar"], .activitybar, [class*="activitybar"]');
                };

                const allClickables = Array.from(document.querySelectorAll('button, [role="button"], a.monaco-button'))
                    .filter(el => {
                        const text = (el.textContent || '').trim();
                        if (text.length === 0 || text.length > 50) return false;
                        if (isExcluded(el)) return false;
                        return isVisible(el);
                    });

                const allClickablesDump = allClickables.map(el => ({
                    tag: el.tagName,
                    text: el.textContent.trim()
                }));

                const reversedClickables = [...allClickables].reverse();

                let approveBtn = reversedClickables.find(btn => {
                    const t = normalize(btn.textContent || '');
                    return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
                }) || null;

                let step = '1';
                let approveBtnText = approveBtn ? approveBtn.textContent.trim() : null;

                if (!approveBtn) {
                    approveBtn = reversedClickables.find(btn => {
                        const t = normalize(btn.textContent || '');
                        const isAlways = ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
                        return !isAlways && ALLOW_PATTERNS.some(p => t === p || t.includes(p));
                    }) || null;
                    step = '2';
                    approveBtnText = approveBtn ? approveBtn.textContent.trim() : null;
                }

                if (!approveBtn) {
                    approveBtn = reversedClickables.find(btn => {
                        const t = normalize(btn.textContent || '');
                        return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
                    }) || null;
                    step = '3';
                    approveBtnText = approveBtn ? approveBtn.textContent.trim() : null;
                }

                if (!approveBtn) {
                    return { ok: false, reason: 'no approve btn', allClickables: allClickablesDump };
                }

                let container = approveBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, div[class*="rounded-2xl"], div[class*="rounded-lg"], div[class*="border"]');
                let containerSource = 'selector';
                if (!container) {
                    let el = approveBtn.parentElement;
                    for (let i = 0; i < 6 && el && el !== document.body; i++) {
                        const clickables = Array.from(el.querySelectorAll('button, [role="button"], a.monaco-button')).filter(b => {
                            const rect = b.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        });
                        if (clickables.some(b => DENY_PATTERNS.some(p => normalize(b.textContent || '').includes(p)))) {
                            container = el;
                            containerSource = 'parent-traversal';
                            break;
                        }
                        el = el.parentElement;
                    }
                }
                if (!container) container = document;

                const containerClickables = Array.from(container.querySelectorAll('button, [role="button"], a.monaco-button'))
                    .filter(btn => {
                        const rect = btn.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    });

                const denyBtn = containerClickables.find(btn => {
                    const t = normalize(btn.textContent || '');
                    return DENY_PATTERNS.some(p => t === p || t.includes(p));
                }) || null;

                return {
                    ok: true,
                    step,
                    approveBtnText,
                    containerFound: !!container,
                    containerSource,
                    denyBtnFound: !!denyBtn,
                    denyBtnText: denyBtn ? denyBtn.textContent.trim() : null,
                    allClickables: allClickablesDump
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
                        expression: findConfirmScript,
                        returnByValue: true,
                        contextId: ctx.id
                    });
                    const val = res?.result?.value;
                    if (val) {
                        console.log(`\nContext ${ctx.id} ("${ctx.name}") Result:`);
                        if (val.ok) {
                            console.log(`  [OK] Approve text: "${val.approveBtnText}" | Deny text: "${val.denyBtnText}"`);
                        } else {
                            console.log(`  [FAIL] Reason: ${val.reason}`);
                            console.log(`  Clickables found:`, val.allClickables.map((c: any) => `${c.tag}: "${c.text}"`).slice(0, 10));
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
