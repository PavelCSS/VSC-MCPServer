# VSC-MCPServer (Multi-Window Fork)

VS Code extension that exposes VS Code's semantic language intelligence over MCP, extended for multi-window workspaces with dynamic port fallback, a shared window registry, and a `stdio`/HTTP routing proxy.

## Rules

- Keep code comments minimal (only non-obvious "why", not "what").
- Run `npm run build`, `npm run lint`, and `npm run test` after edits to `src/`.
- After changes to the extension or proxy, run `npm run sync:plugin` to bump the patch version (`2099.0.x`), package and install the `.vsix` locally into VS Code, and sync `dist/proxy.js` + `extension/vsc-mcpserver.vsix` + `extension/meta.json` to `../my-claude/plugins/vsc-mcp/`.
- Keep the version >= `2099.0.0` in `package.json` so VS Code Marketplace auto-updates do not overwrite this local fork.
- Never edit `dist/` or `releases/` manually; they are generated.

## Commit format

`<type>: <description>` (or `type(scope): description`). Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Commands

```bash
npm install              # Install dependencies
npm run build            # Bundle extension (dist/extension.js) and proxy (dist/proxy.js)
npm run watch            # Watch mode
npm run lint             # ESLint on src/
npm run test             # Vitest unit tests
npm run package          # Build, lint, and package VSIX into releases/
npm run install:local    # Package and force-install VSIX into VS Code
npm run sync:plugin      # Bump patch version, install:local, and sync artifacts to vsc-mcp plugin
```

## Architecture

- **`src/extension.ts`** — Extension lifecycle, commands (`codingwithcalvin.mcp.*`), URI handler, status bar, Antigravity MCP auto-registration.
- **`src/server/mcpServer.ts`** — Express HTTP JSON-RPC server (`/mcp`, `/health`) bound to `127.0.0.1`. Automatically falls back to an ephemeral port (`0`) on `EADDRINUSE` so multiple VS Code windows run concurrently.
- **`src/registry/windowRegistry.ts`** — Atomically writes `{ pid, port, name, workspaceFile, folders, focusedAt }` to `~/.vsc-mcp/windows/<pid>.json` on start, focus, and workspace folder changes; removes it on stop/deactivate.
- **`src/registry/mcpClientRegister.ts`** — Registers/updates the `vscode` stdio proxy entry in Antigravity (`~/.gemini/antigravity/mcp_config.json`) without overwriting unrelated user entries.
- **`src/proxy.ts`** — Standalone Node.js MCP proxy (`dist/proxy.js`, no `vscode` import). Supports `stdio` (default) and `--http --port 4000`. Routes `tools/list` and `tools/call` to the matching live VS Code window by longest prefix match on `workspacePath` / `filePath` / `file` / `path` / `folderPath` / MCP `roots` / `cwd` (falling back to most recently focused), and exposes `vscode_list_windows`.
- **`src/tools/`** — Semantic LSP and workspace tool wrappers (`goToDefinition`, `findReferences`, `hoverInfo`, `diagnostics`, `documentSymbols`, `workspaceSymbols`, `callHierarchy`, `typeHierarchy`, `completions`, `signatureHelp`, `codeActions`, `applyCodeAction`, `renameSymbol`, `formatDocument`, `formatRange`, `organizeImports`, `workspaceFileSearch`, `workspaceTextSearch`, etc.).
- **`scripts/sync-plugin.js`** — Copies `dist/proxy.js`, the packaged `.vsix`, and `meta.json` (version + sha256) into `../my-claude/plugins/vsc-mcp/`.
