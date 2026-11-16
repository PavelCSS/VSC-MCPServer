import * as vscode from 'vscode';
import { z } from 'zod';
import { runWithWarmup } from './warmup';
import { rangeToJSON, Range, ensureDocumentOpen } from '../adapters/vscodeAdapter';

export const findReferencesSchema = z.object({
    uri: z.string().describe('File URI or absolute file path'),
    line: z.number().describe('0-indexed line number'),
    character: z.number().describe('0-indexed character position'),
    includeDeclaration: z.boolean().optional().default(true).describe('Include the declaration in results'),
});

export interface ReferenceLocation {
    uri: string;
    range: Range;
}

function overlaps(a: vscode.Range, b: vscode.Range): boolean {
    const before = (p: vscode.Position, q: vscode.Position) =>
        p.line < q.line || (p.line === q.line && p.character < q.character);
    return !before(a.end, b.start) && !before(b.end, a.start);
}

export async function findReferences(
    params: z.infer<typeof findReferencesSchema>
): Promise<{ references: ReferenceLocation[]; totalCount: number }> {
    // Handle both file:// URIs and plain paths
    let uri: vscode.Uri;
    if (params.uri.startsWith('file://')) {
        uri = vscode.Uri.parse(params.uri);
    } else {
        uri = vscode.Uri.file(params.uri);
    }

    // Ensure document is open
    await ensureDocumentOpen(uri);

    const position = new vscode.Position(params.line, params.character);

    const locations = await runWithWarmup(
        () =>
            vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                uri,
                position
            ),
        (r) => !r || r.length === 0
    );

    if (!locations || locations.length === 0) {
        return { references: [], totalCount: 0 };
    }

    let result = locations;
    if (params.includeDeclaration === false) {
        const definitions = await vscode.commands.executeCommand<
            (vscode.Location | vscode.LocationLink)[]
        >('vscode.executeDefinitionProvider', uri, position);
        const defs = (definitions ?? []).map((d) =>
            'targetUri' in d
                ? { uri: d.targetUri, range: d.targetSelectionRange ?? d.targetRange }
                : { uri: d.uri, range: d.range }
        );
        result = locations.filter(
            (loc) =>
                !defs.some(
                    (d) =>
                        d.range !== undefined &&
                        d.uri.toString() === loc.uri.toString() &&
                        overlaps(loc.range, d.range)
                )
        );
    }

    return {
        references: result.map((loc) => ({
            uri: loc.uri.toString(),
            range: rangeToJSON(loc.range),
        })),
        totalCount: result.length,
    };
}
