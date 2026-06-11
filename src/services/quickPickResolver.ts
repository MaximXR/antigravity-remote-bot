import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

export class QuickPickResolver {
    /**
     * Resolve the VS Code QuickInput dropdown if it appears in any execution context.
     * Selects "Open in current window" option.
     */
    static async resolveQuickPickDialog(cdpService: CdpService): Promise<boolean> {
        const script = `(() => {
            const isVisible = (el) => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            
            const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
            const visibleWidget = widgets.find(isVisible);
            if (!visibleWidget) return { found: false };
            
            const inputEl = visibleWidget.querySelector('.quick-input-filter input');
            const placeholder = ((inputEl ? inputEl.getAttribute('placeholder') : '') || '').toLowerCase();
            const titleEl = visibleWidget.querySelector('.quick-input-title');
            const title = ((titleEl ? titleEl.textContent : '') || '').toLowerCase();
            const widgetText = (visibleWidget.textContent || '').toLowerCase();
            
            const isWindowDialog = placeholder.includes('where to open') || placeholder.includes('open the conversation') || widgetText.includes('where to open');
            const isWorkspaceDialog = placeholder.includes('workspace') || placeholder.includes('select workspace') || widgetText.includes('select workspace') || widgetText.includes('workspace to open');
            
            if (!isWindowDialog && !isWorkspaceDialog) {
                return { found: true, type: 'unknown', placeholder, title };
            }
            
            const rows = Array.from(visibleWidget.querySelectorAll('.monaco-list-row, [role="option"], [role="button"]'));
            const visibleRows = rows.filter(isVisible);
            
            if (isWindowDialog) {
                for (const row of visibleRows) {
                    const rowText = (row.textContent || '').toLowerCase();
                    if (rowText.includes('current window') || rowText.includes('current workspace')) {
                        const rect = row.getBoundingClientRect();
                        return {
                            found: true,
                            type: 'window',
                            text: row.textContent.trim(),
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
                }
            }
            
            if (isWorkspaceDialog) {
                // 1. Try to find a row containing Desktop (current workspace)
                for (const row of visibleRows) {
                    const rowText = (row.textContent || '').toLowerCase();
                    if (rowText.includes('desktop') || rowText.includes('remoat')) {
                        const rect = row.getBoundingClientRect();
                        return {
                            found: true,
                            type: 'workspace',
                            text: row.textContent.trim(),
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
                }
                // 2. Try to find a focused/selected row
                for (const row of visibleRows) {
                    if (row.classList.contains('focused') || row.getAttribute('aria-selected') === 'true') {
                        const rect = row.getBoundingClientRect();
                        return {
                            found: true,
                            type: 'workspace',
                            text: row.textContent.trim(),
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
                }
                // 3. Take the first non-button option
                const optionsOnly = visibleRows.filter(r => !r.classList.contains('monaco-button'));
                if (optionsOnly.length > 0) {
                    const rect = optionsOnly[0].getBoundingClientRect();
                    return {
                        found: true,
                        type: 'workspace',
                        text: optionsOnly[0].textContent.trim(),
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2)
                    };
                }
            }
            
            return { found: true, type: isWindowDialog ? 'window' : 'workspace', error: 'No clickable options found' };
        })()`;

        const maxWaitMs = 5000;
        const started = Date.now();
        let resolvedAny = false;
        
        while (Date.now() - started < maxWaitMs) {
            const contexts = cdpService.getContexts();
            let foundInThisIteration = false;
            
            for (const ctx of contexts) {
                try {
                    const res = await cdpService.call('Runtime.evaluate', {
                        expression: script,
                        returnByValue: true,
                        contextId: ctx.id,
                    });
                    
                    const val = res?.result?.value;
                    if (val && val.found && typeof val.x === 'number' && typeof val.y === 'number') {
                        logger.info(`[QuickPickResolver] Resolving QuickPick (${val.type}) at x=${val.x}, y=${val.y} in context ${ctx.id}: ${val.text}`);
                        await this.cdpMouseClick(cdpService, val.x, val.y);
                        resolvedAny = true;
                        foundInThisIteration = true;
                        break;
                    }
                } catch (_) {
                    // ignore
                }
            }
            
            if (foundInThisIteration) {
                await new Promise((resolve) => setTimeout(resolve, 800));
                continue;
            }
            
            if (resolvedAny) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                let remains = false;
                for (const ctx of cdpService.getContexts()) {
                    try {
                        const check = await cdpService.call('Runtime.evaluate', {
                            expression: `(() => {
                                const isVisible = (el) => {
                                    if (!el || !(el instanceof HTMLElement)) return false;
                                    const style = window.getComputedStyle(el);
                                    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
                                    const rect = el.getBoundingClientRect();
                                    return rect.width > 0 && rect.height > 0;
                                };
                                return !!Array.from(document.querySelectorAll('.quick-input-widget')).find(isVisible);
                            })()`,
                            returnByValue: true,
                            contextId: ctx.id,
                        });
                        if (check?.result?.value) { remains = true; break; }
                    } catch (_) {}
                }
                if (!remains) {
                    logger.info(`[QuickPickResolver] All QuickPick dialogs resolved successfully.`);
                    return true;
                }
            }
            
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return resolvedAny;
    }

    /**
     * Click at coordinates via CDP Input.dispatchMouseEvent.
     */
    private static async cdpMouseClick(cdpService: CdpService, x: number, y: number): Promise<void> {
        await cdpService.call('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y,
        });
        await cdpService.call('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await cdpService.call('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
    }
}
