# Session log — numbering and format

One file per session at `docs/session-log/session-NNNN-<slug>.md`, `NNNN` unpadded.

**Number:** any unused number in `(max, max + 10]`, where `max` is the numeric max over your branch and `origin/main`:

```sh
ls docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1
git ls-tree -r --name-only origin/main -- docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1
```

Take the larger. Never `ls | tail` (lexicographic past 999). The `session-log-numbering` pre-commit guard enforces the window and uniqueness; a window failure usually means a stale base, so fetch and rebase before renumbering.

**Immutability:** never edit, rename, or delete a merged session file (`session-log-immutable` guard). A correction goes in the new session's log as a back-reference.

**Format:** the first line is `# Session NNNN — <title>` (a real H1; the guard greps for it). Then prose: what the session set out to do, what it found or corrected, what shipped (PR numbers), what was verified (the suites actually run, with real counts). No metadata table, no template.

**Plan issues:** `Closes #NN` in the commit only when the whole plan ships; otherwise a status comment on the issue. Reviewer corrections are comments on the issue, not edits to its body. Keep `docs/FEATURE-MAP.md` in sync when user-facing features change.

Sessions 1–800 live in two frozen archive files in the same directory.
