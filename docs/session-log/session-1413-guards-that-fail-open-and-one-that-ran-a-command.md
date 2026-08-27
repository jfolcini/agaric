# Session 1413 — guards that fail open, and one that ran a command

Follow-ups across five guard scripts and the wdio harness (#4466, #4461, #4457). The
common thread is guards that reported success from insufficient evidence — and one that
did considerably more than report.

## The allow-list that admitted a shell

`check-session-log-pr-collision.mjs` needed to confirm the workflow asks `gh` for exactly
one more PR than the cap it enforces. It extracted the limit expression from the workflow,
checked it against an allow-list — `/^[A-Z_0-9$() +]+$/` — and handed it to `bash -c`.

That class admits `$(WORD)`. The input is our own workflow file, not attacker-controlled,
so this was a shape problem rather than a live exploit. But the shape was worse than it
looked. Review demonstrated it rather than arguing it: with a fake `TOUCH` binary on `PATH`
for a single command, the old evaluator both executed the command *and* took its stdout as
the evaluated result — so a payload could run code and simultaneously forge the `cap + 1`
the assertion was checking for. A guard whose own verdict the payload can author is not
bounded by narrowing the allow-list.

The fix removes the shell. The expression must now be the arithmetic-expansion form
`$(( ... ))`, the one named variable is substituted, and the result is evaluated as bare
arithmetic in JS. Twenty-five payloads were tried against the new matcher — nested `$( )`
inside `$(( ))`, backticks, `${}` expansion, trailing `; TOUCH`, newline injection inside
the arithmetic body, process substitution, unicode digits — and none reached a shell.

## Making a check more precise made it less capable

The first version of that replacement validated the substituted text with a character
class, `/^[\s\d+-]+$/`, then summed the tokens. Review found the hole: `String.match()`
skips characters it cannot start a match at rather than failing, so two adjacent signs
lost one. `$((PR_LIST_LIMIT - +1))` summed to `100 + 1 = 101` and **passed**, while the
shell that actually runs it asks `gh` for 99.

That is the exact truncation ambiguity the check exists to catch, waved through by the
assertion meant to catch it — and a regression against the `bash -c` version, which
evaluated it correctly. The comment above the code asserted "summing the signed terms IS
evaluating the expression … no operator precedence to get wrong", a property the code did
not have.

The fix is a grammar rather than a character class — `<int> ( <+|-> <int> )*`, anchored, so
every character is accounted for by a term or an operator — and adjacent signs now fall to
`NaN`, which can never equal `cap + 1`. Fails closed.

Worth stating generally: **replacing a general evaluator with a restricted one trades a
capability for a boundary, and the trade is only sound if the restricted one still decides
every input the general one decided correctly.** Here it silently decided one input wrong.

A related cost surfaced from the same narrowing: the idiomatic `$(($PR_LIST_LIMIT + 1))` is
refused, because admitting `$` back into the body would widen the class this narrowed. That
refusal is deliberate and fails closed, but it surfaced as a bare `evaluated: null` that
reads like a broken guard. It now reports *why* it was rejected, distinguishing "not an
arithmetic expansion at all" (the real drift, e.g. the bare `--limit "$PR_LIST_LIMIT"` of
#4431) from "arithmetic, but spell the variable bare". The matcher was left alone.

## Five smaller instances of the same shape

- **`check-android-so-alignment.mjs`** — a self-test child that dropped two assertions
  without calling `skip()`, so it under-reported its own skipped-group count. The
  end-to-end assertion accepted `\d+` and could not tell. It now requires the exact count,
  which is the only thing that catches the under-report.
- **`check-hook-deps.mjs`** — a verdict that depended on whether a package happened to be
  installed in `node_modules`, i.e. on ambient state rather than on anything committed. Now
  resolved against `package-lock.json`. A package present on disk but absent from the
  lockfile is now `UNVERIFIABLE` where it was previously clean.
- **`check-hook-deps.mjs`, again** — the Python scanner's two halves disagreed: the
  spec-call regex ignored quoted strings and the plain-import regex did not, so an `import`
  inside a non-docstring triple-quoted string read as a real dependency edge. Fixed
  locally rather than by widening the shared helper, because the *other* consumer of that
  helper needs triple-quoted code to stay visible — verified by widening it and watching
  that guard's own assertion go red.
- **`check-space-filter-drift.py`** — a self-test asserting byte-exact empty output, which
  any incidental warning could redden. Loosened to exit-code plus absence of the guard's
  own violation banner. Loosening an assertion deserves suspicion, so both arms were
  pinned: a banner printed with exit 0 still fails.
- **`check-type-aware-liveness.mjs`** — a same-target premise that held only because a
  directory happened to be gitignored, and a `maxBuffer` overflow that returned truncated
  stdout as a valid report. The first was fixed by reordering so the baseline runs before
  the fixture exists, deleting the dependency rather than documenting it. The second by an
  explicit buffer and classifying Node's own `ENOBUFS` code, measured directly rather than
  matched on message text.

## An absent opinion is not agreement

`#4457` is the same failure in the wdio probe: three verdicts printed "the engine agrees it
is visible" whenever `checkVisibility !== false` — a deny-list, which also covers
`checkVisibility === null`, meaning the engine has no such method and offered no opinion at
all. The probe then committed to "a TIMING failure, not a state failure" on evidence it
never obtained.

All three branches now classify positively (`=== true`), and the no-opinion case says so
and issues no verdict. The test that matters pipes a value the type does not even name
through the branch, so the classification cannot quietly revert to a deny-list; it fails
against the old code, which was verified rather than assumed.

## An invariant asserted by a comment and enforced by nothing

The same issue's second half: a comment claimed the session log rescue "is never the same
directory as a per-test rescue", and nothing made that true. `SESSION_LOG_LABEL` is the
bare string `session`, and a root-level test titled `session` — no enclosing describe, so
the parent is empty — sanitizes to exactly that. The per-test rescue would claim the
directory first and the session rescue, which is the *more complete* one because it runs
after the driver is killed, would be skipped as already-rescued.

Enforced in `sanitizeForFilename` rather than at the one call site, so a future caller
inherits the protection instead of silently reintroducing the collision. Both arms are
pinned with concrete expected strings: the collision case gets its suffix, and an ordinary
label still round-trips unchanged. Asserting only that two labels differ would have passed
had both been empty.

The issue's own acceptance said it: *do not leave a comment asserting an invariant nothing
checks.* This batch was two-thirds of the way to doing exactly that — the first pass fixed
the verdict and left the comment, which would have closed the issue on a partial fix.

## What shipped

- #4466 — five guard fixes, including the shell removal and the grammar that replaced the
  character class; hook latency measured rather than guessed, and left alone on the evidence.
- #4461 — the gitignore-dependent premise deleted, and buffer overflow reported as itself.
- #4457 — positive classification for the visibility verdict, and the log-label collision
  enforced at the chokepoint.
