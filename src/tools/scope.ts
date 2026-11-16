import * as path from 'path';
import * as vscode from 'vscode';

export function matchFolder<T extends { fsPath: string }>(
    folders: readonly T[],
    workspacePath: string | undefined
): T | undefined {
    if (!workspacePath) {
        return undefined;
    }
    const target = path.resolve(workspacePath);
    return folders
        .filter((f) => target === f.fsPath || target.startsWith(f.fsPath + path.sep))
        .sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
}

export function resolveScopeFolder(workspacePath: string | undefined): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const match = matchFolder(
        folders.map((f) => ({ fsPath: f.uri.fsPath, folder: f })),
        workspacePath
    );
    return match?.folder;
}
