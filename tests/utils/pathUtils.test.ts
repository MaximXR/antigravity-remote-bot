import { extractProjectNameFromPath, getAntigravityCdpHint, isUntitledTitle, getWorkspaceDisplayPath } from '../../src/utils/pathUtils';

// Helper to temporarily override process.platform
function withPlatform(platform: string, fn: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
        fn();
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
}

describe('pathUtils', () => {
    describe('extractProjectNameFromPath()', () => {
        it('extracts name from POSIX path', () => {
            expect(extractProjectNameFromPath('/home/user/Code/MyProject')).toBe('MyProject');
        });

        it('extracts name from Windows path', () => {
            expect(extractProjectNameFromPath('D:\\Code\\MyProject')).toBe('MyProject');
        });

        it('extracts name from Windows drive root', () => {
            expect(extractProjectNameFromPath('D:\\categorizer')).toBe('categorizer');
        });

        it('handles trailing slash', () => {
            expect(extractProjectNameFromPath('/home/user/Code/MyProject/')).toBe('MyProject');
        });

        it('handles trailing backslash', () => {
            expect(extractProjectNameFromPath('C:\\Code\\MyProject\\')).toBe('MyProject');
        });

        it('handles mixed separators', () => {
            expect(extractProjectNameFromPath('C:\\Users\\test/Code/MyProject')).toBe('MyProject');
        });

        it('returns empty string for empty input', () => {
            expect(extractProjectNameFromPath('')).toBe('');
        });

        it('returns name as-is for simple name', () => {
            expect(extractProjectNameFromPath('MyProject')).toBe('MyProject');
        });
    });

    describe('getAntigravityCdpHint()', () => {
        it('returns open -a hint on macOS', () => {
            withPlatform('darwin', () => {
                expect(getAntigravityCdpHint(9222)).toBe(
                    'open -a Antigravity --args --remote-debugging-port=9222',
                );
            });
        });

        it('returns exe hint on Windows', () => {
            withPlatform('win32', () => {
                expect(getAntigravityCdpHint(9222)).toBe(
                    'Antigravity.exe --remote-debugging-port=9222',
                );
            });
        });

        it('returns lowercase hint on Linux', () => {
            withPlatform('linux', () => {
                expect(getAntigravityCdpHint(9222)).toBe(
                    'antigravity --remote-debugging-port=9222',
                );
            });
        });

        it('uses default port 9222', () => {
            withPlatform('darwin', () => {
                expect(getAntigravityCdpHint()).toContain('9222');
            });
        });

        it('uses custom port', () => {
            withPlatform('darwin', () => {
                expect(getAntigravityCdpHint(9333)).toContain('9333');
            });
        });
    });

    describe('isUntitledTitle()', () => {
        it('returns true for purely empty titles', () => {
            expect(isUntitledTitle('')).toBe(true);
            expect(isUntitledTitle(null as any)).toBe(true);
        });

        it('returns true for untitled/empty window titles', () => {
            expect(isUntitledTitle('untitled')).toBe(true);
            expect(isUntitledTitle('без названия')).toBe(true);
            expect(isUntitledTitle('без имени')).toBe(true);
            expect(isUntitledTitle('Unbenannt - Antigravity IDE')).toBe(true);
        });

        it('returns false for workspace/working area titles even if they contain untitled', () => {
            expect(isUntitledTitle('(Рабочая область) без названия - Antigravity IDE')).toBe(false);
            expect(isUntitledTitle('(Workspace) untitled - Antigravity IDE')).toBe(false);
            expect(isUntitledTitle('робоча область без назви')).toBe(false);
            expect(isUntitledTitle('ワークスペース 無題')).toBe(false);
        });
    });

    describe('getWorkspaceDisplayPath()', () => {
        const fs = require('fs');
        const path = require('path');
        const testWsJson = path.resolve(__dirname, 'temp_test_workspace.json');

        afterEach(() => {
            if (fs.existsSync(testWsJson)) {
                fs.unlinkSync(testWsJson);
            }
        });

        it('returns original path if not workspace.json', () => {
            expect(getWorkspaceDisplayPath('/some/path/to/folder')).toBe('/some/path/to/folder');
        });

        it('resolves relative paths in workspace.json relative to its location', () => {
            const workspaceDir = path.dirname(testWsJson);
            const content = {
                folders: [
                    { path: '.' },
                    { path: '..' },
                    { path: 'some-subfolder' },
                    { path: 'C:\\absolute\\path' }
                ]
            };
            fs.writeFileSync(testWsJson, JSON.stringify(content));

            const resolved = getWorkspaceDisplayPath(testWsJson);
            
            const expectedDot = workspaceDir.replace(/\//g, '\\');
            const expectedParent = path.dirname(workspaceDir).replace(/\//g, '\\');
            const expectedSub = path.resolve(workspaceDir, 'some-subfolder').replace(/\//g, '\\');
            const expectedAbs = 'C:\\absolute\\path';

            expect(resolved).toContain(expectedDot);
            expect(resolved).toContain(expectedParent);
            expect(resolved).toContain(expectedSub);
            expect(resolved).toContain(expectedAbs);
        });
    });
});
