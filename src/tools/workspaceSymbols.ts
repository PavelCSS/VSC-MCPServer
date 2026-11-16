import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { runWithWarmup } from './warmup';
import { resolveScopeFolder } from './scope';
import { rangeToJSON, symbolKindToString, Range } from '../adapters/vscodeAdapter';

export const workspaceSymbolsSchema = z.object({
    query: z.string().describe('Symbol name search query'),
    maxResults: z.number().optional().default(50).describe('Maximum number of results'),
    workspacePath: z
        .string()
        .optional()
        .describe('Restrict results to the workspace folder containing this path'),
});

export interface WorkspaceSymbol {
    name: string;
    kind: string;
    uri: string;
    range: Range;
    containerName?: string;
}

export async function getWorkspaceSymbols(
    params: z.infer<typeof workspaceSymbolsSchema>
): Promise<{ symbols: WorkspaceSymbol[]; totalCount: number }> {
    const { result: all } = await runWithWarmup(
        () =>
            vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                params.query
            ),
        (r) => !r || r.length === 0,
        { workspacePath: params.workspacePath }
    );
    const scope = resolveScopeFolder(params.workspacePath);
    const symbols = scope
        ? all?.filter((s) => s.location.uri.fsPath.startsWith(scope.uri.fsPath + path.sep))
        : all;

    if (!symbols || symbols.length === 0) {
        return { symbols: [], totalCount: 0 };
    }

    const totalCount = symbols.length;
    const limitedSymbols = symbols.slice(0, params.maxResults);

    return {
        symbols: limitedSymbols.map((s) => ({
            name: s.name,
            kind: symbolKindToString(s.kind),
            uri: s.location.uri.toString(),
            range: rangeToJSON(s.location.range),
            containerName: s.containerName || undefined,
        })),
        totalCount,
    };
}
