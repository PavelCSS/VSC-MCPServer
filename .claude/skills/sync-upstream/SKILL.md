---
name: sync-upstream
description: Check https://github.com/CodingWithCalvin/VSC-MCPServer main branch for new commits, merge upstream updates into this fork, resolve merge conflicts while preserving multi-window proxy support, verify build/lint/tests, and sync the updated VSIX to the vsc-mcp plugin. Use when the user asks to check upstream updates, pull changes from CodingWithCalvin/VSC-MCPServer, or sync the fork.
---

# Sync VSC-MCPServer Upstream

## Workflow

1. Run `git status --porcelain`. If uncommitted changes exist, ask the user before proceeding.
2. Run `git remote get-url upstream`. If missing, run `git remote add upstream https://github.com/CodingWithCalvin/VSC-MCPServer.git`.
3. Run `git fetch upstream main`.
4. Run `git log --oneline HEAD..upstream/main`.
5. If the log is empty, report that the fork is up to date and stop.
6. Run `git merge upstream/main --no-commit --no-ff`.
7. If merge conflicts occur, inspect each conflicted file and resolve it:
   - Keep `src/server/mcpServer.ts` `EADDRINUSE` fallback to port `0` and `closeAllConnections()` in `stop()`.
   - Keep `src/extension.ts` calls to `WindowRegistry`, `ensureAntigravityMcpConfig`, and `codingwithcalvin.mcp.copyConfig`.
   - Keep `esbuild.config.js` entry points `['src/extension.ts', 'src/proxy.ts']` with `outdir: 'dist'`.
   - Keep `package.json` `version >= 2099.0.0`, command `codingwithcalvin.mcp.copyConfig`, and scripts `package`, `install:local`, `sync:plugin`.
   - Keep `src/proxy.ts`, `src/registry/windowRegistry.ts`, `src/registry/mcpClientRegister.ts`, `scripts/sync-plugin.js`, `.claude/skills/sync-upstream/SKILL.md`, `CLAUDE.md`, and `README.md` fork sections.
   - Adopt all new upstream tools, bugfixes, and dependencies.
   - Run `git add` on resolved files.
8. List new upstream tools: compare tool names in `src/tools/` with `git diff HEAD --name-only` additions, or `git diff HEAD -- src/tools/`. Ask the user whether to add each new tool to `PROXY_TOOL_ALLOWLIST` in `src/proxy.ts`. Add only the approved tools.
9. Run `npm install && npm run build && npm run lint && npm test`. Fix any failures.
10. Run `npm run sync:plugin` to bump the patch version, install the updated VSIX into VS Code, and copy `dist/proxy.js` (as `dist/proxy.cjs`) and `vsc-mcpserver.vsix` into `../my-claude-marketplace/plugins/vsc-mcp/`.
11. Report the merged upstream commits, resolved conflicts, test results, and the new extension version. Do not run `git commit` or `git push` unless the user asks.
