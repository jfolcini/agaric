# Session log

Per-session entries. **One file per session.**

## Layout

- `session-NNN-<slug>.md` — one file per session. `NNN` is zero-padded to 3 digits (`session-846-...`); the slug is derived from the session title.
- `2024-2025.md` — archived sessions 1 – 400 (frozen, never edited).
- `2026-sessions-401-800.md` — archived sessions 401 – 800 (frozen, never edited).

Sessions 801+ live as individual files in this folder. Earlier sessions stay in the two archive files because splitting hundreds of historical entries into per-session files would be a large diff for no operational benefit.

## Discovery

```sh
ls docs/session-log/session-*.md | sort   # all per-session files in order
ls docs/session-log/session-*.md | tail   # most recent N
```

For a specific session, the slug helps disambiguate: `session-846-cache-rebuilds-*.md`. If you only know the number, glob: `docs/session-log/session-846-*.md`.

## Adding a new session

Append a new file at the next session number. Compute the **numeric** max with `ls docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1`, never with plain `ls | tail` (lexicographic order lies past 999: `session-1000` < `session-996`; the fifteen `session-1000-*` files are that mistake, preserved as history). The guard measures the max over the **union** of your branch and the merge target, so read it from the merge target too and take the larger of the two:

```sh
git ls-tree -r --name-only origin/main -- docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1
```

`max + 1` is the number to take when nothing else is in flight, but the `session-log-numbering` pre-commit hook does **not** require it. Since #3929 it accepts any unused number in the window `(max, max + GAP_BOUND]` — `GAP_BOUND` is 10, defined in `scripts/check-session-log-numbering.sh`, and nothing checks that this sentence and that constant still agree, so several parallel PRs can each hold a distinct valid number instead of every one of them renumbering the moment a sibling merges. What actually prevents a collision is a separate check — the number must not already be taken on your branch, in `origin/main`, or by another file in the same commit — so a gap in the sequence is fine and a reused number is not. A number outside the window still fails, because that means a stale understanding of the max or a typo rather than parallelism. The max the guard measures against spans your branch **and** `origin/main`, so if a window failure surprises you, the usual cause is a stale base — fetch and rebase before renumbering.

Never rename or edit existing files (reviewer corrections go in the PR / issue comments, not in the log). See `.claude/skills/batch-issues/references/session-log.md` for the entry shape and the plan-issue bookkeeping rules.

## Why per-session files

The previous single `SESSION-LOG.md` at repo root grew to ~170 KB before the cutover at session 847. Every session-log update became a merge-conflict magnet (every PR appends; every other concurrent branch then conflicts on the same lines — see `session-843-*.md` for the chained-merge recovery story). Per-session files eliminate the conflict surface: two PRs adding sessions add two different files.
