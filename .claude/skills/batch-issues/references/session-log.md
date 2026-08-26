# Session log — numbering, format, and plan-issue bookkeeping

Create one file per session at `docs/session-log/session-NNNN-<slug>.md`. `NNNN` is an
unused number in the window **`(max, max + GAP_BOUND]`**, no zero-padding — the digit
count above just matches today's live numbers, not a fixed width — where
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

## Session log format

Session logs are prose narratives describing what was accomplished, what was learned, and
what failed or required correction. There is no required metadata table or structured
section format — the purpose of a session log is to preserve knowledge rather than to
record metrics.

The `# Session NNNN — <title>` heading is the first line of the file — a real H1, one `#`,
and nothing above it. This is enforced: the `session-log-numbering` pre-commit guard greps
for `^#[[:space:]]+Session[[:space:]]+[0-9]+` in the staged file and rejects the commit
with "no '# Session NNNN' heading found" if it is missing, so a `##` heading aborts the
commit.

### Typical structure

Most session logs follow this pattern (by convention, not by requirement):

- **Opening paragraph:** a short framing of the work — what the session set out to do,
  or what problem it addressed. Often includes issue numbers.

- **Named sections (##):** multiple sections exploring different aspects of the work,
  lessons learned, corrected assumptions, guards that failed, or mechanisms that were
  discovered. Section titles capture what the session discovered, not a template category.
  Examples: "The docblock forbade this, and it was half right", "What a delete means to
  a block that moved out", "Guards that fail open", "Measurement beat reasoning".

- **What shipped (optional, when applicable):** a section listing the PR numbers and
  brief descriptions of work that shipped, typically formatted as a bulleted list with
  issue/PR numbers.

- **Verification (optional):** a prose description of testing — test counts, CI results,
  areas verified. This is not a command recipe; it summarizes what was checked.

No metadata table, no LOC delta line-item list, and no commit-plan enum are required.
When a session's content naturally calls for any of these (e.g., "21 files changed,
+500/−30" summarizes scope), include it; do not omit it because it is not mandatory.

### Example

```markdown
# Session 1401 — the create event the bus deliberately did not have

#4338. The name-change bus published renames and deletes but never creates, so a page
created anywhere outside a picker's own hook was invisible to every warm cache.

## The docblock forbade this, and it was half right

[explanation of the design and why it was incomplete]

## The steer I gave was wrong, and the mechanism says why

[discovery that the brief's assumption was incorrect, and the mechanism that explains it]

## Falsification

[description of test cases that were reverted to verify the fix was load-bearing]

## Verification

[the suites actually run, with real counts — e.g. "Whole frontend suite: **NNN files,
NNNNN passed**, 1 expected fail, 37 skipped. `tsc -b` clean; `oxlint` clean across all N
changed files."]
```

Only the bracketed spans above are unwritten placeholders. Everything else in the
block — the heading, its number, its title, the opening paragraph (`#4338` included),
and the section titles — is session 1401's real, already-published content, kept
unbracketed here so the example shows what a log's voice and shape actually looks like.
It is not a template to fill in: give your own session its own number, title, opening
paragraph, and section names, and don't carry over any of the surrounding prose. An
earlier draft of this file made exactly this mistake with the Verification counts,
which an author filling in only the bracketed blanks would have republished as their
own; the same risk applies to the unbracketed heading and opening above.

## Plan-issue bookkeeping

- If the session fully resolves a plan, the commit message must include `Closes #NN`
  (GitHub auto-closes the issue when the commit lands on `main`).
- If the session resolves part of a plan, post a status comment on the issue summarizing
  what shipped and what remains — don't close it.
- Reviewer corrections that surface during the session belong as comments on the issue,
  not edits to the body.

**Keep docs/FEATURE-MAP.md in sync:** if the session added commands, components, hooks,
stores, or database tables, update the relevant section.

## Archives

Sessions 1–800 live in two archive files (`docs/session-log/2024-2025.md`,
`docs/session-log/2026-sessions-401-800.md`) — frozen historical records, never edited.
Session 801 onward is one file per session in this directory, as described above; that
range has no fixed upper bound, so it is deliberately not restated here as a number.
