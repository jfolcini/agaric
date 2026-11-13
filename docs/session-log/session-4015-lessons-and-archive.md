# Session 4015 — lessons from sessions 2772 on into the AGENTS files; archive sessions 2701-3900

The same two-commit pass as #6009.

Archive: the 435 per-session files numbered 2701 to 3900 fold into twelve archives,
`sessions-2701-2800.md` through `sessions-3801-3900.md`. The fold script was checked first by
rebuilding the five archives #6009 wrote from their pre-fold files, byte for byte. Each of the
435 sections was then compared with its deleted file (headings demoted, otherwise equal). Every
archive's "Sessions above" line and the README's examples move to 3900. Nothing in the repo
linked to a folded file.

Lessons: six readers each took about 200 KB of logs (2772 to 3993) and returned candidates with
session numbers. The merge kept a rule only when it recurred, was costly, or is a non-obvious
property of the code, and only once the symbols it names were found in the tree. Each one lands
in the nested file where that work happens.

Two corrections:

- `e2e/AGENTS.md` said `selectEditorRange` dispatches `selectionchange`. It now sets
  ProseMirror's selection through `posAtDOM` and counts only editable text.
- `src-tauri/src/mcp/AGENTS.md` now lists the `stub_binary_call_*` smoke tests.

The four-`.sqlx`-caches claim the brief named is already gone from main: every copy names the
one cache, `src-tauri/.sqlx`.

Dropped: candidates the files already state (the `CONFORMANCE_UPDATE` reformat, mutation
`setup: true`, `vmForks`, which `vitest.config.ts` documents), single-session feature facts, and
container-only workarounds with nothing to verify against.

Ran: `prek run --all-files` and `prek run --hook-stage manual --all-files`. Docs only, no builds.
