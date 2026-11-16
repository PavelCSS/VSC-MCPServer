import * as vscode from 'vscode';
import { z } from 'zod';
import {
    rangeToJSON,
    ensureDocumentOpen,
    diagnosticSeverityToString,
    DiagnosticInfo,
} from '../adapters/vscodeAdapter';

const SEVERITIES = ['Error', 'Warning', 'Information', 'Hint'] as const;
const DIAGNOSTICS_WAIT_MS = 3000;

export function normalizeSeverity(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const lower = value.trim().toLowerCase();
    return SEVERITIES.find((s) => s.toLowerCase() === lower) ?? value;
}

function waitForDiagnostics(uri: vscode.Uri, timeoutMs: number): Promise<void> {
    if (typeof vscode.languages.onDidChangeDiagnostics !== 'function') {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
            if (e.uris.some((u) => u.toString() === uri.toString())) {
                finish();
            }
        });
        const timer = setTimeout(finish, timeoutMs);
        function finish() {
            clearTimeout(timer);
            disposable.dispose();
            resolve();
        }
    });
}

export const diagnosticsSchema = z.object({
    uri: z
        .string()
        .optional()
        .describe('File URI or path. If omitted, returns all workspace diagnostics'),
    severityFilter: z
        .array(z.preprocess(normalizeSeverity, z.enum(SEVERITIES)))
        .optional()
        .describe('Filter by severity levels'),
});

export interface DiagnosticsSummary {
    errors: number;
    warnings: number;
    info: number;
    hints: number;
}

export async function getDiagnostics(params: z.infer<typeof diagnosticsSchema>): Promise<{
    diagnostics: DiagnosticInfo[];
    summary: DiagnosticsSummary;
    note?: string;
}> {
    let diagnosticEntries: [vscode.Uri, readonly vscode.Diagnostic[]][];

    if (params.uri) {
        // Handle both file:// URIs and plain paths
        let uri: vscode.Uri;
        if (params.uri.startsWith('file://')) {
            uri = vscode.Uri.parse(params.uri);
        } else {
            uri = vscode.Uri.file(params.uri);
        }
        await ensureDocumentOpen(uri);
        if (vscode.languages.getDiagnostics(uri).length === 0) {
            await waitForDiagnostics(uri, DIAGNOSTICS_WAIT_MS);
        }
        diagnosticEntries = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
        diagnosticEntries = vscode.languages.getDiagnostics();
    }

    let allDiagnostics: DiagnosticInfo[] = diagnosticEntries.flatMap(([uri, diags]) =>
        diags.map((d) => ({
            uri: uri.toString(),
            severity: diagnosticSeverityToString(d.severity),
            message: d.message,
            range: rangeToJSON(d.range),
            source: d.source,
            code:
                typeof d.code === 'object'
                    ? String(d.code.value)
                    : d.code !== undefined
                      ? d.code
                      : undefined,
        }))
    );

    // Apply severity filter
    if (params.severityFilter && params.severityFilter.length > 0) {
        allDiagnostics = allDiagnostics.filter((d) =>
            params.severityFilter!.includes(d.severity as (typeof SEVERITIES)[number])
        );
    }

    const summary: DiagnosticsSummary = {
        errors: allDiagnostics.filter((d) => d.severity === 'Error').length,
        warnings: allDiagnostics.filter((d) => d.severity === 'Warning').length,
        info: allDiagnostics.filter((d) => d.severity === 'Information').length,
        hints: allDiagnostics.filter((d) => d.severity === 'Hint').length,
    };

    return {
        diagnostics: allDiagnostics,
        summary,
        ...(params.uri
            ? {}
            : { note: 'Only open or already loaded files are covered. Pass uri to check a specific file.' }),
    };
}
