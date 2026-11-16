import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
    const { mockVscode } = await import('../test/helpers/mockVscode');
    return mockVscode;
});

import type * as vscode from 'vscode';
import {
    selectProjectDirs,
    runWithWarmup,
    selectWarmFolder,
    hoverIsLoading,
    LOADING_WARNING,
    WarmupDeps,
} from './warmup';
import { matchFolder } from './scope';
import { normalizeSeverity, scopeDiagnosticEntries } from './diagnostics';

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

describe('selectWarmFolder', () => {
    const folders = [{ fsPath: '/w/app' }, { fsPath: '/w/lib' }];

    it('should pick the folder of the file, else the workspacePath folder', () => {
        expect(selectWarmFolder(folders, { filePath: '/w/lib/src/a.ts' })?.fsPath).toBe('/w/lib');
        expect(selectWarmFolder(folders, { workspacePath: '/w/app' })?.fsPath).toBe('/w/app');
        expect(selectWarmFolder(folders, { filePath: '/w/app/a.ts', workspacePath: '/w/lib' })?.fsPath).toBe('/w/app');
    });

    it('should pick nothing without a match', () => {
        expect(selectWarmFolder(folders, { filePath: '/other/a.ts' })).toBeUndefined();
        expect(selectWarmFolder(folders, {})).toBeUndefined();
    });
});

describe('hoverIsLoading', () => {
    it('should detect the loading marker in string, object and array contents', () => {
        expect(hoverIsLoading([{ contents: ['(loading...)'] }])).toBe(true);
        expect(hoverIsLoading([{ contents: [{ value: 'let x: T (loading...)' }] }])).toBe(true);
        expect(hoverIsLoading([{ contents: { value: '(loading...)' } }])).toBe(true);
    });

    it('should ignore other hovers and non-hover values', () => {
        expect(hoverIsLoading([{ contents: [{ value: 'const x: number' }] }])).toBe(false);
        expect(hoverIsLoading(undefined)).toBe(false);
        expect(hoverIsLoading([{ uri: 'x' }])).toBe(false);
    });
});

describe('runWithWarmup', () => {
    const position = {} as vscode.Position;
    const target = { uri: {} as vscode.Uri, position };
    const make = (over: Partial<WarmupDeps> = {}): WarmupDeps => ({
        warm: async () => false,
        isLoading: async () => false,
        takeFresh: () => false,
        sleep: vi.fn().mockResolvedValue(undefined),
        ...over,
    });
    const empty = (r: number[]) => r.length === 0;

    it('should retry once when warmed and the first result is empty', async () => {
        const fn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
        const out = await runWithWarmup(fn, empty, target, make({ warm: async () => true }));
        expect(out).toEqual({ result: [1] });
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry an empty result when not warmed, fresh or loading', async () => {
        const fn = vi.fn().mockResolvedValue([]);
        const out = await runWithWarmup(fn, empty, target, make());
        expect(out).toEqual({ result: [] });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry a non-empty result of a known project', async () => {
        const fn = vi.fn().mockResolvedValue([1]);
        await runWithWarmup(fn, empty, target, make());
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry a non-empty result when the document was freshly opened', async () => {
        const fn = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([1, 2, 3]);
        const out = await runWithWarmup(fn, empty, target, make({ takeFresh: () => true }));
        expect(out).toEqual({ result: [1, 2, 3] });
    });

    it('should poll until loading ends, then retry without a warning', async () => {
        const states = [true, true, false, false];
        const isLoading = vi.fn().mockImplementation(async () => states.shift() ?? false);
        const fn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
        const deps = make({ isLoading });
        const out = await runWithWarmup(fn, empty, target, deps);
        expect(out).toEqual({ result: [1] });
        expect(deps.sleep).toHaveBeenCalledTimes(2);
    });

    it('should return a warning when the server still loads after the poll limit', async () => {
        const fn = vi.fn().mockResolvedValue([]);
        const deps = make({ isLoading: async () => true });
        const out = await runWithWarmup(fn, empty, target, deps);
        expect(out).toEqual({ result: [], warning: LOADING_WARNING });
        expect(deps.sleep).toHaveBeenCalledTimes(30);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should poll a position-less empty result a few times', async () => {
        const fn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([7]);
        const out = await runWithWarmup(fn, empty, { workspacePath: '/w' }, make());
        expect(out).toEqual({ result: [7] });
        expect(fn).toHaveBeenCalledTimes(3);
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

describe('scopeDiagnosticEntries', () => {
    const entries: [{ fsPath: string }, number][] = [
        [{ fsPath: '/w/app/a.ts' }, 1],
        [{ fsPath: '/w/application/b.ts' }, 2],
        [{ fsPath: '/w/lib/c.ts' }, 3],
    ];

    it('should keep only files inside the folder', () => {
        expect(scopeDiagnosticEntries(entries, '/w/app').map(([, d]) => d)).toEqual([1]);
    });

    it('should keep all entries without a folder', () => {
        expect(scopeDiagnosticEntries(entries, undefined)).toHaveLength(3);
    });
});
