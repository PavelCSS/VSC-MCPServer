import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { z } from 'zod';
import { Range } from '../adapters/vscodeAdapter';

export const workspaceTextSearchSchema = z.object({
    query: z.string().describe('Text or regex pattern to search for'),
    isRegex: z.boolean().optional().describe('Whether the query is a regular expression (default: false)'),
    isCaseSensitive: z
        .boolean()
        .optional()
        .describe('Whether the search is case sensitive (default: false)'),
    includePattern: z
        .string()
        .optional()
        .describe('Glob pattern for files to include (e.g., "**/*.ts")'),
    excludePattern: z
        .string()
        .optional()
        .describe('Glob pattern for files to exclude (e.g., "**/node_modules/**")'),
    maxResults: z
        .number()
        .optional()
        .describe('Maximum number of results to return (default: 1000)'),
});

export interface TextSearchResult {
    uri: string;
    relativePath: string;
    matches: {
        range: Range;
        preview: string;
        lineNumber: number;
    }[];
}

const DEFAULT_MAX_RESULTS = 1000;
const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/.git/**'];
const RG_RELATIVE_PATHS = [
    'node_modules/@vscode/ripgrep/bin/rg',
    'node_modules.asar.unpacked/@vscode/ripgrep/bin/rg',
];

type SearchParams = z.infer<typeof workspaceTextSearchSchema>;

export interface RawMatch {
    filePath: string;
    lineNumber: number;
    startCharacter: number;
    endCharacter: number;
    preview: string;
}

export function findRipgrep(
    appRoot: string,
    exists: (p: string) => boolean = fs.existsSync
): string | undefined {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    for (const rel of RG_RELATIVE_PATHS) {
        const candidate = path.join(appRoot, rel.replace(/rg$/, exe));
        if (exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function rgText(v: { text?: string; bytes?: string } | undefined): string | undefined {
    if (!v) {
        return undefined;
    }
    if (typeof v.text === 'string') {
        return v.text;
    }
    return v.bytes ? Buffer.from(v.bytes, 'base64').toString('utf8') : undefined;
}

export function parseRgLine(line: string, cwd: string): RawMatch[] {
    let event: { type?: string; data?: any } | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
        event = JSON.parse(line);
    } catch {
        return [];
    }
    if (event?.type !== 'match') {
        return [];
    }
    const data = event.data;
    const relPath = rgText(data.path);
    const lineText = rgText(data.lines);
    if (relPath === undefined || lineText === undefined) {
        return [];
    }
    const preview = lineText.replace(/\r?\n$/, '');
    const lineBytes = Buffer.from(lineText, 'utf8');
    // rg reports UTF-8 byte offsets; VS Code ranges use UTF-16 code units.
    const toChar = (byteOffset: number): number =>
        lineBytes.subarray(0, byteOffset).toString('utf8').length;
    const filePath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);
    const lineNumber = (data.line_number as number) - 1;
    return (data.submatches as { start: number; end: number }[]).map((m) => ({
        filePath,
        lineNumber,
        startCharacter: toChar(m.start),
        endCharacter: toChar(m.end),
        preview,
    }));
}

export function buildRgArgs(params: SearchParams): string[] {
    const args = ['--json', '--no-config', params.isCaseSensitive ? '--case-sensitive' : '--ignore-case'];
    if (!params.isRegex) {
        args.push('--fixed-strings');
    }
    if (params.includePattern) {
        args.push('--glob', params.includePattern);
    }
    for (const ex of [...DEFAULT_EXCLUDES, ...(params.excludePattern ? [params.excludePattern] : [])]) {
        args.push('--glob', `!${ex}`);
    }
    args.push('--regexp', params.query, '--', '.');
    return args;
}

function runRipgrep(
    rg: string,
    cwd: string,
    params: SearchParams,
    limit: number
): Promise<RawMatch[]> {
    return new Promise((resolve, reject) => {
        const matches: RawMatch[] = [];
        const child = spawn(rg, buildRgArgs(params), { cwd });
        let buffer = '';
        let stderr = '';
        let done = false;

        const consume = (line: string) => {
            if (!line || done) {
                return;
            }
            for (const m of parseRgLine(line, cwd)) {
                if (matches.length >= limit) {
                    done = true;
                    child.kill();
                    return;
                }
                matches.push(m);
            }
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                consume(buffer.slice(0, idx));
                buffer = buffer.slice(idx + 1);
            }
        });
        child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            consume(buffer);
            // rg exits 1 when nothing matched and 2 on partial errors (e.g. unreadable files).
            if (!done && code === 2 && matches.length === 0 && stderr.trim()) {
                reject(new Error(stderr.trim()));
                return;
            }
            resolve(matches);
        });
    });
}

export function matchLine(
    text: string,
    lineNumber: number,
    matcher: RegExp
): Omit<RawMatch, 'filePath'>[] {
    const out: Omit<RawMatch, 'filePath'>[] = [];
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(text)) !== null) {
        if (m[0].length === 0) {
            matcher.lastIndex++;
            continue;
        }
        out.push({
            lineNumber,
            startCharacter: m.index,
            endCharacter: m.index + m[0].length,
            preview: text,
        });
    }
    return out;
}

async function fallbackSearch(params: SearchParams, limit: number): Promise<RawMatch[]> {
    const source = params.isRegex ? params.query : params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(source, params.isCaseSensitive ? 'g' : 'gi');
    const excludes = [...DEFAULT_EXCLUDES, ...(params.excludePattern ? [params.excludePattern] : [])];
    const files = await vscode.workspace.findFiles(
        params.includePattern || '**/*',
        `{${excludes.join(',')}}`
    );
    const matches: RawMatch[] = [];
    for (const file of files) {
        if (matches.length >= limit) {
            break;
        }
        let text: string;
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        } catch {
            continue;
        }
        if (text.includes('\0')) {
            continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
            for (const m of matchLine(lines[i], i, matcher)) {
                if (matches.length >= limit) {
                    break;
                }
                matches.push({ ...m, filePath: file.fsPath });
            }
        }
    }
    return matches;
}

export async function searchWorkspaceText(
    params: SearchParams
): Promise<{ results: TextSearchResult[] }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
        return { results: [] };
    }

    const limit = params.maxResults || DEFAULT_MAX_RESULTS;
    const rg = findRipgrep(vscode.env.appRoot);
    let raw: RawMatch[] = [];

    if (rg) {
        for (const folder of workspaceFolders) {
            if (raw.length >= limit) {
                break;
            }
            raw.push(...(await runRipgrep(rg, folder.uri.fsPath, params, limit - raw.length)));
        }
    } else {
        raw = await fallbackSearch(params, limit);
    }

    const results = new Map<string, TextSearchResult>();
    for (const m of raw) {
        const uri = vscode.Uri.file(m.filePath);
        const key = uri.toString();
        let fileResult = results.get(key);
        if (!fileResult) {
            fileResult = {
                uri: key,
                relativePath: vscode.workspace.asRelativePath(uri, false),
                matches: [],
            };
            results.set(key, fileResult);
        }
        fileResult.matches.push({
            range: {
                startLine: m.lineNumber,
                startCharacter: m.startCharacter,
                endLine: m.lineNumber,
                endCharacter: m.endCharacter,
            },
            preview: m.preview,
            lineNumber: m.lineNumber,
        });
    }
    return { results: Array.from(results.values()) };
}
