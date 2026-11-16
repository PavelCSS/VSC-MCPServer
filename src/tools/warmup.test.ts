import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
    const { mockVscode } = await import('../test/helpers/mockVscode');
    return mockVscode;
});

import { selectProjectDirs, runWithWarmup } from './warmup';
import { matchFolder } from './scope';
import { normalizeSeverity } from './diagnostics';

describe('selectProjectDirs', () => {
    it('should dedupe, sort and cap project dirs', () => {
        const dirs = selectProjectDirs(['/w/b/tsconfig.json', '/w/a/tsconfig.json', '/w/b/tsconfig.json'], 2);
        expect(dirs).toEqual(['/w/a', '/w/b']);
        expect(selectProjectDirs(['/w/c/tsconfig.json', '/w/a/tsconfig.json', '/w/b/tsconfig.json'], 2)).toEqual([
            '/w/a',
            '/w/b',
        ]);
    });
});

describe('runWithWarmup', () => {
    const sleep = vi.fn().mockResolvedValue(undefined);

    it('should retry once when warmed and the first result is empty', async () => {
        const fn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
        const out = await runWithWarmup(fn, (r) => r.length === 0, { warm: async () => true, sleep });
        expect(out).toEqual([1]);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry when nothing was warmed', async () => {
        const fn = vi.fn().mockResolvedValue([]);
        const out = await runWithWarmup(fn, (r) => r.length === 0, { warm: async () => false, sleep });
        expect(out).toEqual([]);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry a non-empty result', async () => {
        const fn = vi.fn().mockResolvedValue([1]);
        await runWithWarmup(fn, (r) => r.length === 0, { warm: async () => true, sleep });
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('matchFolder', () => {
    const folders = [{ fsPath: '/w/app' }, { fsPath: '/w/app/nested' }, { fsPath: '/w/lib' }];

    it('should match the folder itself or the deepest containing folder', () => {
        expect(matchFolder(folders, '/w/lib')?.fsPath).toBe('/w/lib');
        expect(matchFolder(folders, '/w/app/nested/src/a.ts')?.fsPath).toBe('/w/app/nested');
        expect(matchFolder(folders, '/w/app/src')?.fsPath).toBe('/w/app');
    });

    it('should not match sibling prefixes or empty paths', () => {
        expect(matchFolder(folders, '/w/library')).toBeUndefined();
        expect(matchFolder(folders, undefined)).toBeUndefined();
    });
});

describe('normalizeSeverity', () => {
    it('should normalize case', () => {
        expect(normalizeSeverity('error')).toBe('Error');
        expect(normalizeSeverity('INFORMATION')).toBe('Information');
        expect(normalizeSeverity('bogus')).toBe('bogus');
    });
});
