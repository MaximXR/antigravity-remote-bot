import {
    buildWorkspaceListUI,
    isProjectSelectId,
    parseProjectPageId,
    PROJECT_PAGE_PREFIX,
    PROJECT_SELECT_ID,
    WORKSPACE_SELECT_ID,
    ITEMS_PER_PAGE,
} from '../../src/ui/projectListUi';
import { InlineKeyboard } from 'grammy';
import { RecentWorkspace } from '../../src/services/workspaceService';

describe('projectListUi', () => {
    describe('parseProjectPageId', () => {
        it('parses a valid page button customId', () => {
            expect(parseProjectPageId('project_page:0')).toBe(0);
            expect(parseProjectPageId('project_page:3')).toBe(3);
            expect(parseProjectPageId('project_page:99')).toBe(99);
        });

        it('returns NaN for non-matching customId', () => {
            expect(parseProjectPageId('other_id')).toBeNaN();
            expect(parseProjectPageId('project_page')).toBeNaN();
            expect(parseProjectPageId('')).toBeNaN();
        });

        it('returns NaN for malformed page number', () => {
            expect(parseProjectPageId('project_page:abc')).toBeNaN();
        });
    });

    describe('isProjectSelectId', () => {
        it('matches project_select', () => {
            expect(isProjectSelectId(PROJECT_SELECT_ID)).toBe(true);
        });

        it('matches workspace_select', () => {
            expect(isProjectSelectId(WORKSPACE_SELECT_ID)).toBe(true);
        });

        it('matches project_select with suffix', () => {
            expect(isProjectSelectId('project_select:my-project')).toBe(true);
        });

        it('does not match unrelated customIds', () => {
            expect(isProjectSelectId('mode_select')).toBe(false);
            expect(isProjectSelectId('project_page:0')).toBe(false);
            expect(isProjectSelectId('')).toBe(false);
        });
    });

    describe('buildWorkspaceListUI', () => {
        const makeWorkspaces = (count: number): RecentWorkspace[] =>
            Array.from({ length: count }, (_, i) => ({
                path: `E:\\Desktop\\project-${String(i + 1).padStart(3, '0')}`,
                name: `project-${String(i + 1).padStart(3, '0')}`,
                type: 'folder'
            }));

        it('returns empty keyboard for zero workspaces', () => {
            const { text, keyboard } = buildWorkspaceListUI([], 0);

            expect(text).toContain('No workspaces found');
            expect(keyboard).toBeInstanceOf(InlineKeyboard);
        });

        it('shows buttons for workspaces on a single page', () => {
            const workspaces = makeWorkspaces(5);
            const { text, keyboard } = buildWorkspaceListUI(workspaces, 0);

            expect(text).toContain('Workspaces');
            for (const ws of workspaces) {
                expect(text).toContain(ws.name);
                expect(text).toContain(ws.path);
            }
            expect(keyboard).toBeInstanceOf(InlineKeyboard);
        });

        it('does not add page info for single-page results', () => {
            const workspaces = makeWorkspaces(5);
            const { text } = buildWorkspaceListUI(workspaces, 0);

            expect(text).not.toContain('Page');
        });

        it('shows page info for multi-page workspaces', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildWorkspaceListUI(workspaces, 0);

            expect(text).toContain('Page 1 / 2');
            expect(text).toContain('15 workspaces total');
        });

        it('second page shows remaining items', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildWorkspaceListUI(workspaces, 1);

            expect(text).toContain('Page 2 / 2');
            expect(text).toContain(workspaces[10].name);
        });

        it('clamps out-of-range page to the last valid page', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildWorkspaceListUI(workspaces, 100);

            expect(text).toContain('Page 2 / 2');
        });

        it('clamps negative page to 0', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildWorkspaceListUI(workspaces, -5);

            expect(text).toContain('Page 1 / 2');
        });

        it('handles exactly ITEMS_PER_PAGE workspaces (single page)', () => {
            const workspaces = makeWorkspaces(ITEMS_PER_PAGE);
            const { text } = buildWorkspaceListUI(workspaces, 0);

            expect(text).not.toContain('Page');
        });
    });
});

