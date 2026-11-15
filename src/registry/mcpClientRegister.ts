import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 10_000;
const MCP_SERVER_NAME = 'vscode';
const CLAUDE_BINS = [join(homedir(), '.local', 'bin', 'claude'), 'claude'];

export const buildMcpProxyEntry = (proxyPath: string) => ({
    command: 'node',
    args: [proxyPath],
});

const runClaude = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    let lastErr: unknown;
    for (const bin of CLAUDE_BINS) {
        try {
            return await execFileAsync(bin, args, { timeout: CLI_TIMEOUT_MS });
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error('claude CLI not found');
};

const isManagedProxyPath = (value: string): boolean =>
    value.endsWith('/dist/proxy.js') ||
    value.endsWith('\\dist\\proxy.js') ||
    value.includes('/out/mcp/proxy.js') ||
    value.includes('\\out\\mcp\\proxy.js');

const isOwnProxyOutput = (output: string): boolean =>
    output.includes('/dist/proxy.js') ||
    output.includes('\\dist\\proxy.js') ||
    output.includes('/out/mcp/proxy.js') ||
    output.includes('\\out\\mcp\\proxy.js');

const isOwnProxyEntry = (entry: unknown): boolean => {
    if (typeof entry !== 'object' || entry === null) {
        return false;
    }
    const { command, args } = entry as { command?: unknown; args?: unknown };
    return (
        command === 'node' &&
        Array.isArray(args) &&
        typeof args[0] === 'string' &&
        isManagedProxyPath(args[0])
    );
};

const sameEntry = (a: unknown, b: { command: string; args: string[] }): boolean => {
    if (typeof a !== 'object' || a === null) {
        return false;
    }
    const { command, args } = a as { command?: unknown; args?: unknown };
    return (
        command === b.command &&
        Array.isArray(args) &&
        args.length === b.args.length &&
        args.every((v, i) => v === b.args[i])
    );
};

/**
 * Registers the VSC-MCPServer proxy in Claude Code (`claude mcp add -s user vscode ...`)
 * when no `vscode` MCP entry exists yet, or updates our own entry.
 */
export const ensureClaudeMcpConfig = async (proxyPath: string): Promise<boolean> => {
    try {
        const { stdout } = await runClaude(['mcp', 'get', MCP_SERVER_NAME]);
        if (stdout.includes(proxyPath) && !stdout.includes('--windows-dir')) {
            return false;
        }
        if (!isOwnProxyOutput(stdout)) {
            return false;
        }
        await runClaude(['mcp', 'remove', '-s', 'user', MCP_SERVER_NAME]);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return false;
        }
    }

    try {
        await runClaude(['mcp', 'add', '-s', 'user', MCP_SERVER_NAME, '--', 'node', proxyPath]);
        return true;
    } catch {
        return false;
    }
};

/**
 * Registers the VSC-MCPServer proxy in Antigravity (`~/.gemini/antigravity/mcp_config.json`)
 * when Antigravity is present and no `vscode` MCP entry exists yet, or updates our own entry.
 */
export const ensureAntigravityMcpConfig = (
    proxyPath: string,
    antigravityDir = join(homedir(), '.gemini', 'antigravity')
): boolean => {
    if (!existsSync(antigravityDir)) {
        return false;
    }
    const configPath = join(antigravityDir, 'mcp_config.json');
    const targetPath = existsSync(configPath) ? realpathSync(configPath) : configPath;

    let root: Record<string, unknown> = {};
    if (existsSync(targetPath)) {
        try {
            const parsed: unknown = JSON.parse(readFileSync(targetPath, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return false;
            }
            root = parsed as Record<string, unknown>;
        } catch {
            return false;
        }
    }

    const rawServers = root.mcpServers;
    if (
        rawServers !== undefined &&
        (typeof rawServers !== 'object' || rawServers === null || Array.isArray(rawServers))
    ) {
        return false;
    }
    const mcpServers: Record<string, unknown> = rawServers
        ? { ...(rawServers as Record<string, unknown>) }
        : {};

    const existing = mcpServers.vscode;
    const desired = buildMcpProxyEntry(proxyPath);
    if (existing !== undefined && !isOwnProxyEntry(existing)) {
        return false;
    }
    if (sameEntry(existing, desired)) {
        return false;
    }

    mcpServers.vscode = desired;
    const next = { ...root, mcpServers };
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, targetPath);
    return true;
};
