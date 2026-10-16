# Session 2159 — Claude Code's TypeScript LSP is the repo's own tsc

The official `typescript-lsp` plugin starts `typescript-language-server`,
which needs the JavaScript `tsserver`. TypeScript 7, which this repo uses, is
the native compiler and ships no `tsserver`, so that plugin could not start
here. Making it start would have meant a second, older compiler whose errors
disagree with `npm run typecheck`.

TypeScript 7 has its own language server, `tsc --lsp --stdio`. A one-plugin
marketplace in `.claude/marketplace/` runs it from
`${CLAUDE_PROJECT_DIR}/node_modules/.bin/tsc`, and `.claude/settings.json`
declares that marketplace, enables the plugin, and turns the official
`typescript-lsp` off for this project only. Because the settings are
committed, every checkout and worktree gets the same server. Language
servers do not run in cloud sessions.

Checked: `claude plugin validate` passes for the marketplace and the plugin.
With the user-level marketplace registry entry removed, a fresh session
registered the marketplace from the relative path in project settings.
A headless session's LSP `findReferences` on `SectionGroupHeader` returned
the same five files as a hand-driven `tsc --lsp` probe.
