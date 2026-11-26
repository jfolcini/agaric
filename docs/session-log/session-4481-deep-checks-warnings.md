# Session 4481 — the nightly deep checks' build warnings, slow tests and inert accepted mutants

The maintainer asked for every warning, slow test and surviving mutant in tonight's deep checks (run 45727675233) to be fixed. The Rust compiler warnings went to their own PR (#7104), and the npm deprecations to the Node floor PR (#7100). This one carries the rest.

**Build warnings.**
- Vite's "Some chunks are larger than 500 kB" fires only on mermaid's chunk, which loads when a diagram renders. `scripts/check-bundle-budget.mjs` is the size gate for the startup chunks, so `chunkSizeWarningLimit` is off.
- Rolldown's plugin-timings note says the React Compiler's babel pass takes most of the build, which it does by design (`checks.bundlerTimings: false`).
- Cargo warns that `[profile.bench] panic` is ignored. It is ignored for the bench targets only. The bins `cargo bench` builds take it, and on a scratch crate the bench build fails without it (`requires panic strategy abort`). The setting stays, and its comment now says so.

**Slow tests.** `slowTestThreshold` (2000 ms) flagged nine tests.
- **SearchPanel.replace's two refusals** mounted every one of the 1001 matching rows. A 20-row virtualizer window is what the real virtualizer lays out.
- **PairingDialog's transient-poll test** sat through a real 2 s poll. It now uses the file's fake-timer path.
- **EmojiPicker's axe audits** covered an 80-row window. 30 rows still hold the second category header.
- **Four PageModeEditor tests** sat through the real 700 ms idle save. They advance fake time by `CONTENT_COMMIT_DEBOUNCE_MS` instead.
- **Kept as they are:** the scale-envelope tests (they exist to mount 10K rows) and three property tests, at the repo's usual run counts.

No assertion changed. Each faster test was shown red under a mutation of the code it covers.

**Mutants.** The full frontend sweep left no survivor outside `mutation-accepted.tsv`, and the Rust shards finished so far left none at all. Six accepted entries matched no mutant in the complete run: five name lines that no longer exist, and the sixth names a line whose mutants are now all killed. They are pruned.

**Ran.**
- vitest on the four changed test files: 299 passed. Before and after timings were measured interleaved, because the box was loaded.
- `npm run typecheck`, oxlint and oxfmt on the changed files. The e2e build shows no `(!)` and no plugin-timings note.
- The survivor filer, dry-run, against the merged frontend report and the finished Rust shards.
