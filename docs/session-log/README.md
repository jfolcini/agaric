# Session log

Per-session entries. **One file per session.**

## Layout

- `session-NNN-<slug>.md` — one file per session. `NNN` is **never zero-padded** (`session-846-...`, `session-1381-...`); the slug is derived from the session title. The padding rule is not cosmetic: a leading zero makes the guard misreport its own window, and can make it reject the *next* file in the same commit. See [Why the padding rule is not cosmetic](#why-the-padding-rule-is-not-cosmetic).
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

Add a new file numbered in the window `(max, max + GAP_BOUND]` — any unused number from `max + 1` to `max + 10`. `max + 1` is the one to take when nothing else is in flight, but the `session-log-numbering` pre-commit hook has not required it since #3929. Compute the **numeric** max with `ls docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1`, never with plain `ls | tail` (lexicographic order lies past 999: `session-1000` < `session-996`; the fifteen `session-1000-*` files are that mistake, preserved as history). The guard measures the max over the **union** of your branch and the merge target, so read it from the merge target too and take the larger of the two:

```sh
git ls-tree -r --name-only origin/main -- docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1
```

The window exists so several parallel PRs can each hold a distinct valid number instead of every one of them renumbering the moment a sibling merges. `GAP_BOUND` is 10, defined in `scripts/check-session-log-numbering.sh`; nothing checks that this sentence and that constant still agree, so treat the script as the source of truth if they ever diverge. What actually prevents a collision is a separate check — the number must not already be taken on your branch, in `origin/main`, or by another file in the same commit — so a gap in the sequence is fine and a reused number is not. A number outside the window still fails, because that means a stale understanding of the max or a typo rather than parallelism. The max the guard measures against spans your branch **and** the merge target, so if a window failure surprises you, the usual cause is a stale base — fetch and rebase before renumbering.

Two details in which the commands above approximate the guard rather than reproduce it. The guard resolves the merge target as `refs/remotes/origin/main`, falling back to `refs/heads/main` and then to the branch-local check alone. A plain `git clone` creates `refs/remotes/origin/main` itself, so a clone that has never fetched is normally fine for both. The two diverge when that ref is missing entirely — a `--single-branch` clone of some other branch, a remote not named `origin` — and then `git ls-tree origin/main` fails loudly and hands you nothing, while the guard quietly drops to `refs/heads/main`, or to your branch alone, and measures a max you never computed. And the guard reads the **committed** tree (`HEAD`) plus the merge target, while `ls docs/session-log` reads the working directory — so an **untracked** entry counts for you and not for it. A **staged** entry does count for the guard: every session-log addition in the commit is checked for uniqueness against its siblings, and each one advances the window's floor for the entry after it — whether or not it was accepted. Any file whose number the guard could parse sets the floor to its own number plus one, on the collision path and the window path alike, so a single bad number in a multi-file commit also produces a second, unrelated-looking error against the file behind it. The padding case below is exactly that.

Never rename, edit or delete an existing file once it has merged. A session log is append-only: it records what was believed at the time, and silently rewriting that record destroys the value of keeping it. That is why the rule cares about *correcting a statement that is false* and not about *revising what you felt like saying* — an author reworking their own not-yet-merged draft is fine (that file has no reader yet); editing a file a reader may already have read is not, regardless of how small the change looks.

So when a merged log needs a correction, it goes in the **new** session's log, as a back-reference to the one being corrected — e.g. "session-1430 said X; it was wrong because Y" — never as an edit to the existing file. A PR or issue comment is not a substitute: nobody reading `session-1430-*.md` later will see a comment on #4530. The `session-log-immutable` pre-commit guard (`prek.toml`) enforces the mechanical half: any staged edit, rename, deletion or typechange of a `session-*.md` file that is already in the merge target's tree fails the commit — four operations, matching the guard's `--diff-filter=DMRT`. Deletion counts because it destroys the record more completely than an edit does, and because a rename that also rewrites the body is staged by git as a deletion plus an addition rather than as a rename — so a guard that ignored deletions would miss exactly the case it most needs to catch. Typechange counts because replacing the file with a symlink or a gitlink destroys it just as thoroughly while being neither a modification nor a deletion. The guard does not know what a correction looks like, so writing the back-reference itself is on the author; and it covers only the per-session `session-*.md` files, not the two archive files (`2024-2025.md`, `2026-sessions-401-800.md`), which the rule still applies to by convention. An archive compaction — the one legitimate reason to delete merged `session-*.md` files, since its whole job is to fold them into those archives — is the case the guard is meant to be overridden for: `SKIP=session-log-immutable git commit …`. That override is named here rather than only in the guard's error message, so it is discoverable while planning a compaction instead of after tripping over it. See `.claude/skills/batch-issues/references/session-log.md` for the entry shape and the plan-issue bookkeeping rules.

### Why the padding rule is not cosmetic

The two places that consume the extracted number disagree about what a leading zero means. `num_of()` in `scripts/check-session-log-numbering.sh` pulls `NNN` out with `sed` and passes the string along untouched. The window check is the `test` builtin (`[ "$n" -lt "$expected" ]`), which reads its operands as decimal, so `session-0755-...` is compared as 755 and fails for the ordinary reason — 755 is far below the current max. The error is the confusing part: the window it names (`must be between 1382 and 1391`) looks nothing like the number you just typed, so the failure reads as the guard having lost track of the max rather than as a padding mistake. The running floor, though, is bash arithmetic (`expected=$((n + 1))`), where a leading zero does mean octal: `0755` becomes 493 there, so the *next* staged entry in the same commit is measured against a window around 494 (`must be between 494 and 503`) and fails for a reason that has nothing to do with its own number. A padded number containing an 8 or a 9 (`0846`) additionally kills the guard with `value too great for base` — but only after the window check has already printed its own error.

## Why per-session files

The previous single `SESSION-LOG.md` at repo root grew to ~170 KB before the cutover at session 847. Every session-log update became a merge-conflict magnet (every PR appends; every other concurrent branch then conflicts on the same lines — see `session-843-*.md` for the chained-merge recovery story). Per-session files eliminate the conflict surface: two PRs adding sessions add two different files.
