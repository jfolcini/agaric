# Session log — template & conventions

Create one file per session at `docs/session-log/session-NNN-<slug>.md`. `NNN` is an
unused number in the window **`(max, max + GAP_BOUND]`**, no zero-padding, where
`GAP_BOUND` is 10 (`scripts/check-session-log-numbering.sh`). `max + 1` is the number
to take when nothing else is in flight; the window exists so several parallel PRs can
each hold a distinct valid number instead of every one renumbering the moment a sibling
merges.

The max the guard measures spans **your branch and the merge target**, so compute it
over the union:

```sh
ls docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1
git ls-tree -r --name-only origin/main -- docs/session-log | grep -oP 'session-\K[0-9]+' | sort -n | tail -1
```

Take the larger of the two. Reading only the merge target under-counts when your branch
already holds a higher number.

The first command approximates the guard rather than reproducing it: the guard reads the
**committed** tree (`HEAD`) plus the merge target, while `ls docs/session-log` reads the
working directory — so an **untracked** entry counts for you and not for it. A **staged**
entry does count for the guard, and each staged addition advances the window's floor for
the one after it whether or not its own number was accepted.

**Never derive it from plain `ls | tail`** — past session-999 that sorts
lexicographically (`session-1000` < `session-996`) and reports a stale max; fifteen
sessions collided on `session-1000` this way.

What prevents a collision is not the window but a **separate uniqueness check**: the
number must not already be taken on your branch, in `origin/main`, or by a sibling file
in the same commit. So a gap in the sequence is fine and a reuse is not. A number
outside the window still fails, because that means a stale max or a typo rather than
parallelism — if a window failure surprises you, fetch and rebase before renumbering.
The `session-log-numbering` pre-commit guard (`prek.toml`) enforces both checks at
commit time.

`<slug>` is a short kebab-case derivation of the title. **One file per session, never
appended to.** See `docs/session-log/README.md` for naming + discovery conventions.

## Plan-issue bookkeeping

- If the session fully resolves a plan, the commit message must include `Closes #NN`
  (GitHub auto-closes the issue when the commit lands on `main`).
- If the session resolves part of a plan, post a status comment on the issue summarizing
  what shipped and what remains — don't close it.
- Reviewer corrections that surface during the session belong as comments on the issue,
  not edits to the body.

**Keep docs/FEATURE-MAP.md in sync:** if the session added commands, components, hooks,
stores, or database tables, update the relevant section.

## Template

The `# Session N — …` heading is the first line of the file — a real H1, one `#`, and
nothing above it. This is enforced: the `session-log-numbering` pre-commit guard greps
for `^#[[:space:]]+Session[[:space:]]+[0-9]+` in the staged file and rejects the commit
with "no '# Session NNNN' heading found" if it is missing, so a `##` heading aborts the
commit.

```text
# Session N — <short title> (YYYY-MM-DD)

| Metadata | Value |
|----------|-------|
| **Date** | YYYY-MM-DD |
| **Subagents** | <count> build + <count> review (or "orchestrator-only") |
| **Items closed** | <ID list — issue `#NN`, or "—"> |
| **Items modified** | <ID list, or "—"> |
| **Tests added** | +N (frontend) / +M (backend) |
| **Files touched** | <count> |

**Summary:** <2-3 sentence high-level outcome>

**Files touched (this session):**
- `path/to/file.ext` (LOC delta)
- ...

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — N tests run, N passed. (Bare form
  without `--workspace` is package-scoped to `agaric` only and silently skips every
  `agaric-engine`/`agaric-store`/`agaric-sync`/etc. test — #3212.)
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:** <optional, only when worth capturing>

**Lessons learned (for future sessions):** <optional, only when applicable>

**Commit plan:** single commit / split / not pushed / pushed.
```

Do NOT add a trailing `---` separator — the file ends at the commit-plan line.

Apply this template to NEW sessions. Sessions 801–846 already migrated to per-session
files; sessions 1–800 remain in the two archive files (`docs/session-log/2024-2025.md`,
`docs/session-log/2026-sessions-401-800.md`) — frozen historical records, never edited.
