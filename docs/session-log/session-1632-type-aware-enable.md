# Session 1632 — turning the type-aware lint on

`oxlint --type-aware` now runs in `npm run lint` and in the `oxlint` prek hook,
which is what CI runs. This is the last of five PRs; #4884, #4887, #4888 and
#4889 cleared ten of the twelve rules, and this one clears the eleventh and
wires the flag.

## A correction

Session 1627 said the flag "is passed nowhere: not in the `lint` script, not in
the prek hook, not in CI". The first two were true and the third was not.
`scheduled-deep-checks.yml` has had a `type-aware-lint` lane since #4408: it
runs `npx oxlint --type-aware -f json` weekly, reporting-only, with
`check-type-aware-liveness.mjs` as the one thing allowed to fail the job —
because a step that cannot fail is a step that can silently stop running. Its
own header already names the ratchet this work followed: "Findings feed the
per-rule burn-down; promote a rule to `error` in `.oxlintrc.json` once its
count reaches zero."

So the rules had never *blocked* anything, which is what should have been said.

## only-throw-error kept its `error`

Thirteen sites failed once type information arrived. Two are production code
throwing the raw `{ kind, message, code? }` object on purpose: that object is
what a rejected Tauri command actually rejects with, which is why `unwrap()`
rethrows it verbatim and why `isAppError` exists to narrow it.

Thirteen per-site disables would have suppressed the rule rather than told it
the truth. It takes an `allow` list of type specifiers, so it now carries
`{ "from": "file", "name": "AppError" }` — a statement about this codebase's IPC
boundary, not a hole. Both production sites cleared on that alone.
`TypedAppError` was tried alongside and matched nothing extra, being a plain
alias, so it is not in the list.

Six tests hand-rolled the same wire object in a mock; naming the type turns each
from an anonymous literal into a fixture checked against the generated
`AppError`, so a test faking a `kind` the backend cannot send now fails to
compile. `PagePropertyTable`'s message-less case was `new Error() as unknown as
Record<string, unknown>`, mutated and thrown — a genuine `Error` the whole time,
double-cast only to write `undefined` over `message`. `Reflect.set` does that
without pretending it is something else.

Five throw a string because the non-Error path is the thing under test. Each
takes a narrow disable naming that reason. The `graph-worker` one had been
carrying `// biome-ignore lint/style/useThrowOnlyError` — a directive for a
linter this repo removed (invariant 5), suppressing nothing for however long.

## Why those five disables could not ship earlier

`--report-unused-disable-directives-severity=error` is in both the script and
the hook. Without type information `only-throw-error` reports nothing, so a
disable for it reads as dead and the run fails. The pre-commit hook rejected
exactly this, twice, before the coupling was obvious: **a disable for a
type-aware-only rule and the flag itself have to land in the same commit.**
That is also why `require-array-sort-compare`'s two `no-misused-spread` disables
are not in this PR — they follow in the one that clears those rules.

## The two that remain

`require-array-sort-compare` (42) and `no-misused-spread` (5) are held at
`"warn"`, on the ratchet the React Compiler block above them already documents,
and each is promoted to `"error"` by the PR that takes its count to zero.
Deliberately not `"off"`: an `off` rule reports nothing, and a rule that reports
nothing cannot tell "clean" apart from "not scanned" — the same argument
`react/rule-suppression` makes twenty lines up.

## Cost

Measured on this machine, not estimated.

| | before | after |
|---|---|---|
| one file (the pre-commit case) | 0.27s | 0.73s |
| `prek run oxlint --all-files` (the CI case) | 2.57s | 19.02s |

The CI `lint` job has a 30-minute budget against an observed ~11 minutes.

## Verification

`npm run lint` exits 0 with the flag on, printing the 47 held-at-warn findings.
The gate was falsified against a copy: appending `return await 1` to an `async`
function in `src/lib/logger.ts` — a violation only type information can see —
reddens it with `typescript(await-thenable)` and exit 1; restoring the file
(`cmp`-checked) returns it to 0. `prek run oxlint --all-files` passes. 528 tests
across the eight touched files pass; `npm run typecheck` is clean.

The same run against the pristine `prek.toml` fails, which is the other half of
the proof: without the flag, this PR's five disables are unused directives.
