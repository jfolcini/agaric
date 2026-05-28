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

Append a new file at the next session number — never rename or edit existing files (reviewer corrections go in the PR / issue comments, not in the log). See `PROMPT.md` § "Session log entry template" for the entry shape.

## Why per-session files

The previous single `SESSION-LOG.md` at repo root grew to ~170 KB before the cutover at session 847. Every session-log update became a merge-conflict magnet (every PR appends; every other concurrent branch then conflicts on the same lines — see `session-843-*.md` for the chained-merge recovery story). Per-session files eliminate the conflict surface: two PRs adding sessions add two different files.
