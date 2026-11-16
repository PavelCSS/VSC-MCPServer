import * as path from 'path';
import * as vscode from 'vscode';
import { matchFolder } from './scope';
import { noteOpened, takeFreshlyOpened } from './openTracker';

const MAX_PROJECTS = 20;
const TIME_BUDGET_MS = 5000;
const RETRY_DELAY_MS = 1500;
const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 30;
const SYMBOL_POLL_ATTEMPTS = 3;
export const LOADING_WARNING =
    'TypeScript server is still loading the project; results may be incomplete';
const EXCLUDE = '**/{node_modules,build,dist,.git}/**';

const warmedFolders = new Set<string>();

export function selectProjectDirs(tsconfigPaths: string[], max: number = MAX_PROJECTS): string[] {
    const dirs = new Set<string>();
    for (const p of tsconfigPaths) {
        dirs.add(path.dirname(p));
    }
    return Array.from(dirs).sort().slice(0, max);
}

export interface WarmupTarget {
    uri?: vscode.Uri;
    position?: vscode.Position;
    workspacePath?: string;
}

export function selectWarmFolder<T extends { fsPath: string }>(
    folders: readonly T[],
    target: { filePath?: string; workspacePath?: string }
): T | undefined {
    return matchFolder(folders, target.filePath ?? target.workspacePath);
}

export function hoverIsLoading(hovers: unknown): boolean {
    if (!Array.isArray(hovers)) {
        return false;
    }
    return hovers.some((h) => {
        const contents: unknown[] = Array.isArray(h?.contents) ? h.contents : [h?.contents];
        return contents.some((c) => {
            const text = typeof c === 'string' ? c : (c as { value?: unknown } | undefined)?.value;
            return typeof text === 'string' && text.includes('(loading...)');
        });
    });
}

export function resetWarmupState(): void {
    warmedFolders.clear();
}

async function warmFolder(folder: vscode.WorkspaceFolder, deadline: number): Promise<boolean> {
    const configs = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/tsconfig.json'),
        EXCLUDE,
        200
    );
    let opened = false;
    for (const dir of selectProjectDirs(configs.map((c) => c.fsPath))) {
        if (Date.now() > deadline) {
            break;
        }
        const sources = await vscode.workspace.findFiles(
            new vscode.RelativePattern(dir, '**/*.{ts,tsx}'),
            `{${EXCLUDE},**/*.d.ts}`,
            1
        );
        if (sources.length > 0) {
            try {
                await vscode.workspace.openTextDocument(sources[0]);
                noteOpened(sources[0].toString(), false);
                opened = true;
            } catch {
                // unreadable file: skip
            }
        }
    }
    return opened;
}

export async function warmUpWorkspace(target: WarmupTarget = {}): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const match = selectWarmFolder(
        folders.map((f) => ({ fsPath: f.uri.fsPath, folder: f })),
        { filePath: target.uri?.fsPath, workspacePath: target.workspacePath }
    );
    if (!match) {
        return false;
    }
    const key = match.folder.uri.toString();
    if (warmedFolders.has(key)) {
        return false;
    }
    warmedFolders.add(key);
    try {
        return await warmFolder(match.folder, Date.now() + TIME_BUDGET_MS);
    } catch {
        return false;
    }
}

export interface WarmupDeps {
    warm: (target: WarmupTarget) => Promise<boolean>;
    isLoading: (target: WarmupTarget) => Promise<boolean>;
    takeFresh: (target: WarmupTarget) => boolean;
    sleep: (ms: number) => Promise<void>;
}

async function hoverLoading(target: WarmupTarget): Promise<boolean> {
    if (!target.uri || !target.position) {
        return false;
    }
    try {
        return hoverIsLoading(
            await vscode.commands.executeCommand('vscode.executeHoverProvider', target.uri, target.position)
        );
    } catch {
        return false;
    }
}

const defaultDeps: WarmupDeps = {
    warm: warmUpWorkspace,
    isLoading: hoverLoading,
    takeFresh: (t) => (t.uri ? takeFreshlyOpened(t.uri.toString()) : false),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface Guarded<T> {
    result: T;
    warning?: string;
}

async function waitUntilLoaded(target: WarmupTarget, deps: WarmupDeps): Promise<void> {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        await deps.sleep(POLL_INTERVAL_MS);
        if (!(await deps.isLoading(target))) {
            return;
        }
    }
}

export async function runWithWarmup<T>(
    fn: () => Promise<T>,
    isEmpty: (result: T) => boolean,
    target: WarmupTarget = {},
    deps: WarmupDeps = defaultDeps
): Promise<Guarded<T>> {
    const fresh = deps.takeFresh(target);
    const warmed = await deps.warm(target);
    const first = await fn();

    if (!target.position) {
        let result = first;
        for (let i = 0; i < SYMBOL_POLL_ATTEMPTS && isEmpty(result); i++) {
            await deps.sleep(i === 0 && warmed ? RETRY_DELAY_MS : POLL_INTERVAL_MS);
            result = await fn();
        }
        return { result };
    }

    const suspicious = isEmpty(first) || warmed || fresh;
    if (!suspicious) {
        return { result: first };
    }
    const wasLoading = await deps.isLoading(target);
    if (!wasLoading && !warmed && !fresh) {
        return { result: first };
    }
    if (wasLoading) {
        await waitUntilLoaded(target, deps);
    } else {
        await deps.sleep(RETRY_DELAY_MS);
    }
    const result = await fn();
    const stillLoading = await deps.isLoading(target);
    return stillLoading ? { result, warning: LOADING_WARNING } : { result };
}
