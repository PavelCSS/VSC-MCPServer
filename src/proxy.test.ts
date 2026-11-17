import { describe, it, expect } from 'vitest';
import { coerceArgs, handleProxyRpc } from './proxy';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('coerceArgs', () => {
    it('should convert string numbers and booleans', () => {
        expect(
            coerceArgs({ maxResults: '10', includeDeclaration: 'false', newWindow: 'true', other: '5' })
        ).toEqual({ maxResults: 10, includeDeclaration: false, newWindow: true, other: '5' });
    });

    it('should keep typed and invalid values', () => {
        expect(coerceArgs({ maxResults: 3, newWindow: 'maybe' })).toEqual({
            maxResults: 3,
            newWindow: 'maybe',
        });
    });
});

describe('tools/call routing', () => {
    it('should route by the uri argument and coerce args', async () => {
        const received: any[] = [];
        const make = (tag: string) =>
            new Promise<{ port: number; close: () => void }>((resolve) => {
                const srv = createServer((req, res) => {
                    let body = '';
                    req.on('data', (c) => (body += c));
                    req.on('end', () => {
                        received.push({ tag, body: JSON.parse(body) });
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: tag } }));
                    });
                });
                srv.listen(0, '127.0.0.1', () =>
                    resolve({ port: (srv.address() as any).port, close: () => srv.close() })
                );
            });
        const a = await make('a');
        const b = await make('b');
        const dir = mkdtempSync(join(tmpdir(), 'vscmcp-'));
        const reg = (name: string, folder: string, port: number) =>
            writeFileSync(
                join(dir, `${name}.json`),
                JSON.stringify({ pid: process.pid, name, folders: [folder], port, focusedAt: name === 'a' ? 2 : 1 })
            );
        reg('a', '/proj/a', a.port);
        reg('b', '/proj/b', b.port);

        const res = await handleProxyRpc(
            {
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: {
                    name: 'workspace_symbols',
                    arguments: { uri: 'file:///proj/b/src/x.ts', maxResults: '5' },
                },
            },
            { windowsDir: dir, clientRoots: [] }
        );
        a.close();
        b.close();

        expect(res).toMatchObject({ id: 7, result: { ok: 'b' } });
        expect(received).toHaveLength(1);
        expect(received[0].body.params.arguments.maxResults).toBe(5);
    });
});

describe('tool allowlist', () => {
    it('should list only allowlisted tools', async () => {
        const srv = createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                const tools = ['hover_info', 'completions', 'format_document', 'diagnostics'].map((name) => ({
                    name,
                    description: name,
                    inputSchema: { type: 'object', properties: {} },
                }));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: 'proxy-tools', result: { tools } }));
            });
        });
        await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
        const dir = mkdtempSync(join(tmpdir(), 'vscmcp-'));
        writeFileSync(
            join(dir, 'a.json'),
            JSON.stringify({
                pid: process.pid,
                name: 'a',
                folders: ['/proj/a'],
                port: (srv.address() as any).port,
                focusedAt: 1,
            })
        );
        const res = await handleProxyRpc(
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { windowsDir: dir, clientRoots: ['/proj/a'] }
        );
        srv.close();

        const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
        expect(names).toEqual(['vscode_list_windows', 'hover_info', 'diagnostics']);
    });

    it('should reject a disabled tool without forwarding', async () => {
        let hits = 0;
        const srv = createServer((req, res) => {
            hits++;
            res.end('{}');
        });
        await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
        const dir = mkdtempSync(join(tmpdir(), 'vscmcp-'));
        writeFileSync(
            join(dir, 'a.json'),
            JSON.stringify({
                pid: process.pid,
                name: 'a',
                folders: ['/proj/a'],
                port: (srv.address() as any).port,
                focusedAt: 1,
            })
        );
        const res = await handleProxyRpc(
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'format_document', arguments: {} } },
            { windowsDir: dir, clientRoots: ['/proj/a'] }
        );
        srv.close();

        expect(res).toEqual({
            jsonrpc: '2.0',
            id: 2,
            result: {
                content: [{ type: 'text', text: 'Tool format_document is disabled in vsc-mcp proxy' }],
                isError: true,
            },
        });
        expect(hits).toBe(0);
    });
});
