import * as vscode from 'vscode';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WindowRegistration {
    pid: number;
    port: number;
    name: string;
    workspaceFile: string | null;
    folders: string[];
    focusedAt: number;
}

const REGISTRY_DIR = join(homedir(), '.vsc-mcp', 'windows');
const OWN_FILE = join(REGISTRY_DIR, `${process.pid}.json`);

export class WindowRegistry {
    private port: number | undefined;
    private focusedAt: number = vscode.window.state.focused ? Date.now() : 0;

    register(port: number): void {
        this.port = port;
        this.write();
    }

    updateFocus(focused: boolean): void {
        if (!focused) {
            return;
        }
        this.focusedAt = Date.now();
        this.write();
    }

    updateWorkspace(): void {
        this.write();
    }

    unregister(): void {
        this.port = undefined;
        try {
            rmSync(OWN_FILE, { force: true });
        } catch {
            // ignore cleanup failures
        }
    }

    private write(): void {
        if (this.port === undefined) {
            return;
        }
        try {
            mkdirSync(REGISTRY_DIR, { recursive: true });
            const data: WindowRegistration = {
                pid: process.pid,
                port: this.port,
                name: vscode.workspace.name ?? '',
                workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
                folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
                focusedAt: this.focusedAt,
            };
            const tmp = `${OWN_FILE}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(data), 'utf8');
            renameSync(tmp, OWN_FILE);
        } catch {
            // best-effort registry update
        }
    }
}
