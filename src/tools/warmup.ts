import * as path from 'path';
import * as vscode from 'vscode';

const MAX_PROJECTS = 20;
const TIME_BUDGET_MS = 5000;
const RETRY_DELAY_MS = 1500;
const EXCLUDE = '**/{node_modules,build,dist,.git}/**';

const warmedFolders = new Set<string>();

export function selectProjectDirs(tsconfigPaths: string[], max: number = MAX_PROJECTS): string[] {
    const dirs = new Set<string>();
    for (const p of tsconfigPaths) {
        dirs.add(path.dirname(p));
    }
    return Array.from(dirs).sort().slice(0, max);
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
                opened = true;
            } catch {
                // unreadable file: skip
            }
        }
    }
    return opened;
}

export async function warmUpWorkspace(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const deadline = Date.now() + TIME_BUDGET_MS;
    let warmed = false;
    for (const folder of folders) {
        const key = folder.uri.toString();
        if (warmedFolders.has(key) || Date.now() > deadline) {
            continue;
        }
        warmedFolders.add(key);
        try {
            warmed = (await warmFolder(folder, deadline)) || warmed;
        } catch {
            // warm-up is best effort
        }
    }
    return warmed;
}

export interface WarmupDeps {
    warm: () => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
}

const defaultDeps: WarmupDeps = {
    warm: warmUpWorkspace,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function runWithWarmup<T>(
    fn: () => Promise<T>,
    isEmpty: (result: T) => boolean,
    deps: WarmupDeps = defaultDeps
): Promise<T> {
    const warmed = await deps.warm();
    const first = await fn();
    if (!warmed || !isEmpty(first)) {
        return first;
    }
    await deps.sleep(RETRY_DELAY_MS);
    return fn();
}
