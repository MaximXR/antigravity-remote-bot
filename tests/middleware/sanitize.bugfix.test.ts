import { resolveSafePath } from '../../src/middleware/sanitize';
import path from 'path';

describe('resolveSafePath — bug fix coverage', () => {
    const baseDir = '/home/user/workspace';

    it('allows subdirectory paths', () => {
        expect(resolveSafePath('a/b/c', baseDir)).toBe(path.resolve(baseDir, 'a/b/c'));
    });

    it('allows exact base directory', () => {
        expect(resolveSafePath('.', baseDir)).toBe(path.resolve(baseDir));
    });

    it('blocks parent traversal with ../', () => {
        expect(() => resolveSafePath('../outside', baseDir)).toThrow('Path traversal detected');
    });

    it('blocks exact ".." path', () => {
        expect(() => resolveSafePath('..', baseDir)).toThrow('Path traversal detected');
    });

    it('blocks multi-level traversal', () => {
        expect(() => resolveSafePath('../../etc/passwd', baseDir)).toThrow('Path traversal detected');
    });

    it('blocks absolute paths outside base', () => {
        expect(() => resolveSafePath('/etc/passwd', baseDir)).toThrow('Path traversal detected');
    });

    it('allows absolute paths inside base', () => {
        const insidePath = path.resolve(baseDir, 'project', 'file.txt');
        expect(resolveSafePath(insidePath, baseDir)).toBe(insidePath);
    });

    // Bug fix verification: dead code removed (path.isAbsolute(relative) was always false)
    // This test confirms the traversal check still works without the dead code
    it('still blocks traversal after dead code removal', () => {
        // path.relative('/home/user/workspace', '/etc/passwd') = '../../../etc/passwd'
        // This starts with '..' + sep, so line 9 catches it
        expect(() => resolveSafePath('/tmp/evil', baseDir)).toThrow('Path traversal detected');
    });

    it('handles embedded ../ that resolves inside base', () => {
        // e.g. 'a/../b' resolves to 'b' which is inside base
        expect(resolveSafePath('a/../b', baseDir)).toBe(path.resolve(baseDir, 'b'));
    });

    it('blocks embedded ../ that resolves outside base', () => {
        expect(() => resolveSafePath('a/../../outside', baseDir)).toThrow('Path traversal detected');
    });
});
