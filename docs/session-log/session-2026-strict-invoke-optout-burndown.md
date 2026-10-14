# Session 2026 — Strict-invoke opt-outs burned down, baseline deleted

Part of #5469. The eight test files still replacing `@tauri-apps/api/core`
with a bare `vi.fn()` now build `invoke` as `vi.fn(strictInvokeFallback)`, so
an IPC a test never stubbed fails the test instead of reading as success.

Most files needed only the factory change. `StaticBlock`'s three query-block
tests had been rendering `{{query …}}` against an unstubbed
`list_tags_by_prefix` and `run_advanced_query`; they now stub both as empty.
`AppShellErrorBoundaries` had a blanket empty-page fallback for every command;
it now stubs the shell's boot calls by name.

With nothing left in it, the baseline has no job, so it is deleted rather than
kept empty: the guard fails on any opt-out, naming file and line, and exits 2
when it scans no test files. Its `check-baseline-paths` registration and the
stale `--update-baseline` advice in `src/__tests__/AGENTS.md` went with it.

Suites run: the eight converted files, `npm run typecheck`, oxlint, the guard
itself, and the guard shown red by re-adding a bare mock on a copy.
