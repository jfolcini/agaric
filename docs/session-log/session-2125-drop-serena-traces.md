# Session 2125 — Drop the Serena references

The maintainer no longer uses the Serena MCP server, so the repo stops
mentioning it: the `.serena/` ignore rule in `.gitignore`, the `.serena`
entry in `stryker.config.mjs`'s ignore list, the "Serena is client-side"
clause in `AGENTS.md` § Code Navigation, and a test comment in
`src/editor/__tests__/node-view-mobile-freeze.test.ts` that named it
alongside tsserver.

The archived session logs that mention Serena stay as they are: they are
append-only.

Nothing to test: with no `.serena/` directory, the two ignore entries
matched nothing, and the other two changes are prose.
