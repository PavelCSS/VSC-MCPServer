import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 15_000;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface RegisteredWindow {
    pid: number;
    port: number;
    name: string;
    workspaceFile: string | null;
    folders: string[];
    focusedAt: number;
}

const VSCODE_LIST_WINDOWS_TOOL: ToolDefinition = {
    name: 'vscode_list_windows',
    description: 'List all live VS Code windows registered by VSC-MCPServer with their workspace folders and ports.',
    inputSchema: {
        type: 'object',
        properties: {},
    },
};

const jsonText = (data: unknown) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

const errorText = (message: string) => ({
    content: [{ type: 'text', text: message }],
    isError: true,
});

const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
};

const isInside = (target: string, root: string): boolean => {
    const a = resolve(target);
    const b = resolve(root);
    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

const targetToPath = (target?: string | null): string | undefined => {
    if (!target) {
        return undefined;
    }
    if (target.startsWith('file://')) {
        try {
            return fileURLToPath(target);
        } catch {
            return undefined;
        }
    }
    return target;
};

export const resolveWindowsDir = (explicit?: string): string => {
    if (explicit) {
        return explicit;
    }
    if (process.env.VSC_MCP_WINDOWS_DIR) {
        return process.env.VSC_MCP_WINDOWS_DIR;
    }
    return join(homedir(), '.vsc-mcp', 'windows');
};

export const readLiveWindows = (windowsDir: string): RegisteredWindow[] => {
    let files: string[];
    try {
        files = readdirSync(windowsDir).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    const live: RegisteredWindow[] = [];
    for (const file of files) {
        try {
            const info = JSON.parse(readFileSync(join(windowsDir, file), 'utf8')) as RegisteredWindow;
            if (typeof info.port === 'number' && info.port > 0 && isAlive(info.pid)) {
                live.push(info);
            }
        } catch {
            // ignore partial or invalid registry files
        }
    }
    return live;
};

export const selectWindow = (windows: RegisteredWindow[], targetPath?: string): RegisteredWindow | undefined => {
    if (!windows.length) {
        return undefined;
    }
    if (targetPath) {
        const normalized = resolve(targetPath);
        let best: RegisteredWindow | undefined;
        let bestScore = -1;
        for (const w of windows) {
            const wsFile = targetToPath(w.workspaceFile);
            let score = -1;
            if (wsFile && resolve(wsFile) === normalized) {
                score = wsFile.length + 10_000;
            }
            for (const folder of w.folders) {
                if (isInside(normalized, folder)) {
                    score = Math.max(score, resolve(folder).length);
                }
            }
            if (
                score > bestScore ||
                (score === bestScore && score >= 0 && (w.focusedAt ?? 0) > (best?.focusedAt ?? 0))
            ) {
                best = w;
                bestScore = score;
            }
        }
        if (best) {
            return best;
        }
    }
    return windows.reduce((a, b) => ((b.focusedAt ?? 0) > (a.focusedAt ?? 0) ? b : a));
};

const forwardToWindow = (port: number, req: JsonRpcRequest): Promise<JsonRpcResponse> =>
    new Promise((resolvePromise, reject) => {
        const body = JSON.stringify(req);
        const httpReq = httpRequest(
            {
                hostname: '127.0.0.1',
                port,
                path: '/mcp',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Window MCP returned HTTP ${res.statusCode}: ${text}`));
                        return;
                    }
                    try {
                        resolvePromise(JSON.parse(text) as JsonRpcResponse);
                    } catch (err) {
                        reject(err instanceof Error ? err : new Error(String(err)));
                    }
                });
            }
        );
        httpReq.on('timeout', () => {
            httpReq.destroy(new Error('Window MCP request timed out'));
        });
        httpReq.on('error', reject);
        httpReq.write(body);
        httpReq.end();
    });

const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
});

const COERCE_TYPES: Record<string, 'number' | 'boolean'> = {
    maxResults: 'number',
    includeDeclaration: 'boolean',
    newWindow: 'boolean',
};

export const coerceArgs = (args: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...args };
    for (const [key, type] of Object.entries(COERCE_TYPES)) {
        const val = out[key];
        if (typeof val !== 'string') {
            continue;
        }
        if (type === 'boolean') {
            if (val === 'true') {
                out[key] = true;
            } else if (val === 'false') {
                out[key] = false;
            }
        } else if (val.trim() !== '' && !Number.isNaN(Number(val))) {
            out[key] = Number(val);
        }
    }
    return out;
};

const pickTargetPath = (args: Record<string, unknown>, clientRoots: string[]): string => {
    for (const key of ['workspacePath', 'uri', 'filePath', 'file', 'path', 'folderPath']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim()) {
            return key === 'uri' ? (targetToPath(val) ?? val) : val;
        }
    }
    if (clientRoots.length) {
        return clientRoots[0];
    }
    return process.cwd();
};

export interface ProxyContext {
    windowsDir: string;
    clientRoots: string[];
}

export const handleProxyRpc = async (
    req: JsonRpcRequest,
    ctx: ProxyContext
): Promise<JsonRpcResponse | undefined> => {
    const id = req.id ?? null;
    if (req.method === 'notifications/initialized' || req.method.startsWith('notifications/')) {
        return undefined;
    }
    switch (req.method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'vsc-mcp-proxy', version: '1.0.0' },
                },
            };
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': {
            const windows = readLiveWindows(ctx.windowsDir);
            const targetPath = ctx.clientRoots[0] ?? process.cwd();
            const win = selectWindow(windows, targetPath);
            if (!win) {
                return { jsonrpc: '2.0', id, result: { tools: [VSCODE_LIST_WINDOWS_TOOL] } };
            }
            try {
                const res = await forwardToWindow(win.port, {
                    jsonrpc: '2.0',
                    id: 'proxy-tools',
                    method: 'tools/list',
                });
                const upstreamTools = ((res.result as { tools?: ToolDefinition[] } | undefined)?.tools ?? []).map(
                    (t) => ({
                        ...t,
                        inputSchema: {
                            ...t.inputSchema,
                            properties: {
                                ...(t.inputSchema?.properties ?? {}),
                                workspacePath: {
                                    type: 'string',
                                    description:
                                        'Optional workspace folder or .code-workspace path to route to a specific VS Code window.',
                                },
                            },
                        },
                    })
                );
                return { jsonrpc: '2.0', id, result: { tools: [VSCODE_LIST_WINDOWS_TOOL, ...upstreamTools] } };
            } catch {
                return { jsonrpc: '2.0', id, result: { tools: [VSCODE_LIST_WINDOWS_TOOL] } };
            }
        }
        case 'tools/call': {
            const params = req.params ?? {};
            const name = typeof params.name === 'string' ? params.name : '';
            const rawArgs =
                typeof params.arguments === 'object' && params.arguments !== null
                    ? (params.arguments as Record<string, unknown>)
                    : {};
            if (!name) {
                return rpcError(id, -32602, 'Missing tool name');
            }

            const windows = readLiveWindows(ctx.windowsDir);
            if (name === VSCODE_LIST_WINDOWS_TOOL.name) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: jsonText({
                        windowsDir: ctx.windowsDir,
                        windows: windows.map((w) => ({
                            pid: w.pid,
                            name: w.name,
                            workspaceFile: targetToPath(w.workspaceFile) ?? null,
                            folders: w.folders,
                            port: w.port,
                            focusedAt: w.focusedAt,
                        })),
                    }),
                };
            }

            const targetPath = pickTargetPath(rawArgs, ctx.clientRoots);
            const win = selectWindow(windows, targetPath);
            if (!win?.port) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: errorText(
                        `No live VSC-MCPServer window found (searched ${ctx.windowsDir} for "${targetPath}").`
                    ),
                };
            }
            const forwardArgs = coerceArgs(rawArgs);
            delete forwardArgs.workspacePath;
            const forwardReq: JsonRpcRequest = {
                ...req,
                params: { ...params, name, arguments: forwardArgs },
            };
            try {
                const forwarded = await forwardToWindow(win.port, forwardReq);
                return { ...forwarded, id };
            } catch (err) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: errorText(
                        `Failed to reach VSC-MCPServer window "${win.name}" on port ${win.port}: ${err instanceof Error ? err.message : String(err)}`
                    ),
                };
            }
        }
        default:
            return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
};

const parseArgs = (argv: string[]) => {
    let http = false;
    let port = 4000;
    let windowsDir: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--http') {
            http = true;
        } else if (a === '--port' && argv[i + 1]) {
            port = Number(argv[++i]) || 4000;
        } else if (a === '--windows-dir' && argv[i + 1]) {
            windowsDir = argv[++i];
        }
    }
    return { http, port, windowsDir: resolveWindowsDir(windowsDir) };
};

const runStdio = (ctx: ProxyContext) => {
    let pendingRootsId: number | undefined;
    let nextClientReqId = 1;
    let clientSupportsRoots = false;

    const writeOut = (msg: unknown) => {
        process.stdout.write(`${JSON.stringify(msg)}\n`);
    };

    const requestRoots = () => {
        pendingRootsId = nextClientReqId++;
        writeOut({ jsonrpc: '2.0', id: pendingRootsId, method: 'roots/list', params: {} });
    };

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            writeOut(rpcError(null, -32700, 'Parse error'));
            return;
        }

        if (pendingRootsId !== undefined && msg.id === pendingRootsId && !('method' in msg)) {
            pendingRootsId = undefined;
            const result = msg.result as { roots?: Array<{ uri?: string }> } | undefined;
            const paths = (result?.roots ?? [])
                .map((r) => (typeof r.uri === 'string' ? targetToPath(r.uri) : undefined))
                .filter((p): p is string => Boolean(p));
            if (paths.length) {
                ctx.clientRoots = paths;
            }
            return;
        }

        const req = msg as unknown as JsonRpcRequest;
        if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
            writeOut(rpcError((req?.id as JsonRpcId) ?? null, -32600, 'Invalid Request'));
            return;
        }

        if (req.method === 'initialize') {
            const caps = (req.params?.capabilities as Record<string, unknown> | undefined) ?? {};
            clientSupportsRoots = Boolean(caps.roots);
        } else if (
            (req.method === 'notifications/initialized' || req.method === 'notifications/roots/list_changed') &&
            clientSupportsRoots
        ) {
            requestRoots();
        }

        void handleProxyRpc(req, ctx)
            .then((reply) => {
                if (reply !== undefined) {
                    writeOut(reply);
                }
            })
            .catch((err) => {
                writeOut(rpcError(req.id ?? null, -32603, err instanceof Error ? err.message : String(err)));
            });
    });
};

const runHttp = (ctx: ProxyContext, port: number) => {
    const server = createServer((req, res) => {
        const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
        if (host !== '127.0.0.1' && host !== 'localhost') {
            res.writeHead(403).end('Forbidden');
            return;
        }
        if (req.method !== 'POST' || req.url?.split('?')[0] !== '/mcp') {
            res.writeHead(404).end('Not Found');
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            let parsed: JsonRpcRequest;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest;
            } catch {
                const body = JSON.stringify(rpcError(null, -32700, 'Parse error'));
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(body);
                return;
            }
            void handleProxyRpc(parsed, ctx).then((reply) => {
                if (reply === undefined) {
                    res.writeHead(202).end();
                    return;
                }
                const body = JSON.stringify(reply);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                }).end(body);
            });
        });
    });
    server.listen(port, '127.0.0.1', () => {
        process.stderr.write(`VSC-MCPServer proxy listening on http://127.0.0.1:${port}/mcp\n`);
    });
};

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    const ctx: ProxyContext = { windowsDir: opts.windowsDir, clientRoots: [] };
    if (opts.http) {
        runHttp(ctx, opts.port);
    } else {
        runStdio(ctx);
    }
}
