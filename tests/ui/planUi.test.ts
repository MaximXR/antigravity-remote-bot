import {
    buildPlanNotificationUI,
    buildPlanContentUI,
    paginatePlanContent,
    PLAN_VIEW_BTN,
    PLAN_PROCEED_BTN,
    PLAN_EDIT_BTN,
    PLAN_REFRESH_BTN,
    PLAN_PAGE_PREFIX,
} from '../../src/ui/planUi';
import type { PlanningInfo } from '../../src/services/planningDetector';
import { buildTelegramKeyboard } from '../../src/bot/telegramAdapter';

describe('planUi', () => {
    const info: PlanningInfo = {
        openText: 'Open',
        proceedText: 'Proceed',
        planTitle: 'refactor-auth.md',
        planSummary: 'Refactor the authentication module',
        description: 'This plan refactors the auth module to use JWT tokens.',
    };

    describe('buildPlanNotificationUI', () => {
        it('builds notification with all four buttons', () => {
            const { text, buttons } = buildPlanNotificationUI(info, 'my-project', '12345');
            const keyboard = buildTelegramKeyboard(buttons);

            expect(text).toContain('Plan Ready');
            expect(text).toContain('refactor-auth.md');
            expect(text).toContain('my-project');
            expect(text).toContain('JWT tokens');

            const rows = (keyboard as any).inline_keyboard;
            expect(rows.length).toBe(2);
            expect(rows[0].length).toBe(2);
            expect(rows[1].length).toBe(2);

            // Button callback data
            expect(rows[0][0].callback_data).toContain(PLAN_VIEW_BTN);
            expect(rows[0][1].callback_data).toContain(PLAN_PROCEED_BTN);
            expect(rows[1][0].callback_data).toContain(PLAN_EDIT_BTN);
            expect(rows[1][1].callback_data).toContain(PLAN_REFRESH_BTN);
        });

        it('falls back to planSummary when description is empty', () => {
            const infoNoDesc = { ...info, description: '' };
            const { text } = buildPlanNotificationUI(infoNoDesc, 'proj', '999');

            expect(text).toContain('Refactor the authentication module');
        });

        it('falls back to default text when both description and summary are empty', () => {
            const infoEmpty = { ...info, description: '', planSummary: '' };
            const { text } = buildPlanNotificationUI(infoEmpty, 'proj', '999');

            expect(text).toContain('awaiting your review');
        });
    });

    describe('paginatePlanContent', () => {
        it('returns single page for short content', () => {
            const pages = paginatePlanContent('Short plan content');
            expect(pages).toHaveLength(1);
            expect(pages[0]).toBe('Short plan content');
        });

        it('returns "(Empty plan)" for empty content', () => {
            const pages = paginatePlanContent('');
            expect(pages).toEqual(['(Empty plan)']);
        });

        it('splits long content into multiple pages at newline boundaries', () => {
            const line = 'A'.repeat(100) + '\n';
            const content = line.repeat(50); // ~5050 chars
            const pages = paginatePlanContent(content, 2000);

            expect(pages.length).toBeGreaterThan(1);
            for (const page of pages) {
                expect(page.length).toBeLessThanOrEqual(2000);
            }

            // All content should be preserved
            const rejoined = pages.join('\n');
            expect(rejoined.replace(/\n/g, '')).toBe(content.replace(/\n/g, ''));
        });

        it('hard-splits when no newline within page size', () => {
            const content = 'X'.repeat(5000);
            const pages = paginatePlanContent(content, 2000);

            expect(pages.length).toBe(3);
            expect(pages[0].length).toBe(2000);
        });
    });

    describe('buildPlanContentUI', () => {
        it('builds single page without navigation buttons (no proceedText)', () => {
            const pages = ['Plan content here'];
            const { text, buttons } = buildPlanContentUI(pages, 0, 'proj', '123');
            const keyboard = buildTelegramKeyboard(buttons);

            expect(text).toContain('Plan Content');
            expect(text).toContain('Plan content here');
            // Single page should not show page numbers like "(1/1)"
            expect(text).not.toMatch(/\(\d+\/\d+\)/);

            const rows = (keyboard as any).inline_keyboard;
            // No proceedText → 3 action buttons (Edit, Refresh, View Full)
            const allButtons = rows.flat();
            expect(allButtons.length).toBe(3);
            const cbData = allButtons.map((b: any) => b.callback_data);
            expect(cbData.some((d: string) => d.includes(PLAN_PROCEED_BTN))).toBe(false);
            expect(cbData.some((d: string) => d.includes(PLAN_EDIT_BTN))).toBe(true);
            expect(cbData.some((d: string) => d.includes(PLAN_REFRESH_BTN))).toBe(true);
            expect(cbData.some((d: string) => d.includes(PLAN_VIEW_BTN))).toBe(true);
        });

        it('includes Proceed button when proceedText is provided', () => {
            const pages = ['Plan content here'];
            const { buttons } = buildPlanContentUI(pages, 0, 'proj', '123', 'implementation_plan.md', 'Proceed');
            const keyboard = buildTelegramKeyboard(buttons);

            const rows = (keyboard as any).inline_keyboard;
            const allButtons = rows.flat();
            expect(allButtons.length).toBe(4);
            const cbData = allButtons.map((b: any) => b.callback_data);
            expect(cbData.some((d: string) => d.includes(PLAN_PROCEED_BTN))).toBe(true);
        });

        it('builds multi-page with navigation buttons', () => {
            const pages = ['Page 1', 'Page 2', 'Page 3'];

            // First page: only Next
            const { text: t1, buttons: b1 } = buildPlanContentUI(pages, 0, 'proj', '123');
            const k1 = buildTelegramKeyboard(b1);
            expect(t1).toContain('(1/3)');
            const rows1 = (k1 as any).inline_keyboard;
            expect(rows1[0].length).toBe(1);
            expect(rows1[0][0].callback_data).toContain(PLAN_PAGE_PREFIX);
            expect(rows1[0][0].text).toContain('Next');

            // Middle page: Prev and Next
            const { text: t2, buttons: b2 } = buildPlanContentUI(pages, 1, 'proj', '123');
            const k2 = buildTelegramKeyboard(b2);
            expect(t2).toContain('(2/3)');
            const rows2 = (k2 as any).inline_keyboard;
            expect(rows2[0].length).toBe(2);

            // Last page: only Prev
            const { buttons: b3 } = buildPlanContentUI(pages, 2, 'proj', '123');
            const k3 = buildTelegramKeyboard(b3);
            const rows3 = (k3 as any).inline_keyboard;
            expect(rows3[0].length).toBe(1);
            expect(rows3[0][0].text).toContain('Prev');
        });
    });
});
