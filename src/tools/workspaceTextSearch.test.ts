import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module - must be before imports that use vscode
vi.mock('vscode', async () => {
    const { mockVscode } = await import('../test/helpers/mockVscode');
    return mockVscode;
});

import {
    searchWorkspaceText,
    workspaceTextSearchSchema,
    parseRgLine,
    findRipgrep,
    buildRgArgs,
} from './workspaceTextSearch';
import { truncatePreview, parseRgLine } from './workspaceTextSearch';
import { mockVscode, resetMocks, MockUri } from '../test/helpers/mockVscode';

describe('Workspace Text Search Tool', () => {
    beforeEach(() => {
        resetMocks();
        mockVscode.workspace.workspaceFolders = [
            { uri: MockUri.file('/test/workspace'), name: 'test-workspace' },
        ];
    });

    describe('Schema Validation', () => {
        it('should validate correct parameters', () => {
            const validParams = {
                query: 'searchTerm',
            };

            const result = workspaceTextSearchSchema.safeParse(validParams);
            expect(result.success).toBe(true);
        });

        it('should validate with all optional parameters', () => {
            const validParams = {
                query: 'searchTerm',
                isRegex: true,
                isCaseSensitive: true,
                includePattern: '**/*.ts',
                excludePattern: '**/node_modules/**',
                maxResults: 100,
            };

            const result = workspaceTextSearchSchema.safeParse(validParams);
            expect(result.success).toBe(true);
        });

        it('should reject missing query', () => {
            const invalidParams = {};

            const result = workspaceTextSearchSchema.safeParse(invalidParams);
            expect(result.success).toBe(false);
        });
    });

    describe('parseRgLine', () => {
        it('should convert a match event with byte offsets to character ranges', () => {
            const line = JSON.stringify({
                type: 'match',
                data: {
                    path: { text: 'src/a.ts' },
                    lines: { text: 'é foo bar\n' },
                    line_number: 3,
                    submatches: [{ match: { text: 'foo' }, start: 3, end: 6 }],
                },
            });
            expect(parseRgLine(line, '/ws')).toEqual([
                {
                    filePath: '/ws/src/a.ts',
                    lineNumber: 2,
                    startCharacter: 2,
                    endCharacter: 5,
                    preview: 'é foo bar',
                },
            ]);
        });

        it('should ignore non-match events and invalid lines', () => {
            expect(parseRgLine(JSON.stringify({ type: 'begin', data: {} }), '/ws')).toEqual([]);
            expect(parseRgLine('not json', '/ws')).toEqual([]);
        });
    });

    describe('findRipgrep and buildRgArgs', () => {
        it('should find the unpacked binary when the first path is missing', () => {
            const found = findRipgrep('/app', (p) => p.includes('node_modules.asar.unpacked'));
            expect(found).toContain('node_modules.asar.unpacked');
            expect(findRipgrep('/app', () => false)).toBeUndefined();
        });

        it('should exclude node_modules and .git by default', () => {
            const args = buildRgArgs({ query: 'x', excludePattern: '**/dist/**', includePattern: '*.ts' });
            expect(args).toEqual(
                expect.arrayContaining(['!**/node_modules/**', '!**/.git/**', '!**/dist/**', '*.ts', '--fixed-strings'])
            );
            expect(buildRgArgs({ query: 'x', isRegex: true, isCaseSensitive: true })).toEqual(
                expect.arrayContaining(['--case-sensitive'])
            );
            expect(buildRgArgs({ query: 'x', isRegex: true })).not.toContain('--fixed-strings');
        });
    });

    describe('fallback search', () => {
        it('should match line by line when rg is not found', async () => {
            mockVscode.workspace.findFiles.mockResolvedValue([MockUri.file('/test/workspace/a.ts')]);
            mockVscode.workspace.fs.readFile.mockResolvedValue(
                Buffer.from('nothing\nconst Foo = foo + 1;\n')
            );

            const result = await searchWorkspaceText({ query: 'foo' });

            expect(result.results).toHaveLength(1);
            expect(result.results[0].relativePath).toBe('a.ts');
            expect(result.results[0].matches).toEqual([
                {
                    range: { startLine: 1, startCharacter: 6, endLine: 1, endCharacter: 9 },
                    preview: 'const Foo = foo + 1;',
                    lineNumber: 1,
                },
                {
                    range: { startLine: 1, startCharacter: 12, endLine: 1, endCharacter: 15 },
                    preview: 'const Foo = foo + 1;',
                    lineNumber: 1,
                },
            ]);
        });

        it('should honour case sensitivity, regex and maxResults', async () => {
            mockVscode.workspace.findFiles.mockResolvedValue([MockUri.file('/test/workspace/a.ts')]);
            mockVscode.workspace.fs.readFile.mockResolvedValue(Buffer.from('Foo\nfoo\nfoo\n'));

            const cs = await searchWorkspaceText({ query: 'foo', isCaseSensitive: true });
            expect(cs.results[0].matches.map((m) => m.lineNumber)).toEqual([1, 2]);

            const re = await searchWorkspaceText({ query: 'f.o', isRegex: true, maxResults: 2 });
            expect(re.results[0].matches).toHaveLength(2);
        });

        it('should return empty results without workspace folders', async () => {
            mockVscode.workspace.workspaceFolders = [];
            expect(await searchWorkspaceText({ query: 'x' })).toEqual({ results: [] });
        });
    });

    describe('preview truncation', () => {
        const long = 'a'.repeat(500) + 'NEEDLE' + 'b'.repeat(500);

        it('should centre the match and mark both cut sides', () => {
            const out = truncatePreview(long, 500, 506);
            expect(out.startsWith('…')).toBe(true);
            expect(out.endsWith('…')).toBe(true);
            expect(out).toContain('NEEDLE');
            expect(out.length).toBe(202);
        });

        it('should mark only the cut side near the line start', () => {
            const out = truncatePreview('NEEDLE' + 'b'.repeat(500), 0, 6);
            expect(out.startsWith('NEEDLE')).toBe(true);
            expect(out.endsWith('…')).toBe(true);
            expect(out.length).toBe(201);
        });

        it('should keep short lines unchanged', () => {
            expect(truncatePreview('short', 0, 2)).toBe('short');
        });

        it('should truncate in the fallback path', async () => {
            mockVscode.workspace.findFiles.mockResolvedValue([MockUri.file('/test/workspace/a.min.js')]);
            mockVscode.workspace.fs.readFile.mockResolvedValue(Buffer.from(long));
            const result = await searchWorkspaceText({ query: 'NEEDLE' });
            const m = result.results[0].matches[0];
            expect(m.preview.length).toBe(202);
            expect(m.preview).toContain('NEEDLE');
            expect(m.range.startCharacter).toBe(500);
        });

        it('should truncate in the rg path', () => {
            const line = JSON.stringify({
                type: 'match',
                data: {
                    path: { text: 'a.js' },
                    lines: { text: long + '\n' },
                    line_number: 1,
                    submatches: [{ start: 500, end: 506 }],
                },
            });
            const [m] = parseRgLine(line, '/w');
            expect(m.preview.length).toBe(202);
            expect(m.preview).toContain('NEEDLE');
            expect(m.startCharacter).toBe(500);
        });
    });
});
