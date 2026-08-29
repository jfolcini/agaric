# Session 1437 — the lint that was not run

#4493 was my own issue, filed while working #4407, and it asked for the wrong thing. It read as
a directive-scope defect: an `oxlint-disable-next-line react-hooks/exhaustive-deps` at the bottom
of `useListStyles` was eating `react/refs` diagnostics for lines *above* it, which no sane
directive scope allows. The fix looked like "make the directive scope the line it names".

There is no such fix. What the directive does is not scoping — it is a **bailout**.

## The mechanism, and why nothing in this repo can remove it

oxlint ports `babel-plugin-react-compiler`'s suppression bailout verbatim (oxc #24747, and
#25392 for the transform side). A disable directive naming any of `react-hooks/exhaustive-deps`,
`react-hooks/rules-of-hooks`, `react/exhaustive-deps` or `react/rules-of-hooks` — in either the
`oxlint-` or the `eslint-` spelling — makes the compiler **skip the enclosing component or hook
entirely**. Every other `react/*` rule then goes silent for that whole function, above the
directive as well as below it.

It is deliberate: an author-declared incomplete dependency array means the compiler must not
trust its own inference for that function. It is present and unchanged in oxlint **1.79.0** — the
version pinned in `package.json` and installed at `node_modules/.bin/oxlint`, which is the binary
actually checked here. (A newer 1.80.0 exists upstream; it is not what this repo runs, and an
earlier draft of this note cited it by mistake.) And no key in `.oxlintrc.json` switches it off.
So the thing #4493 asked to fix is not a bug and not configurable; the only variable left is
whether the silence is **visible**.

## The measurement, with its denominator

Of **1858** lintable files in the tree: **172** carry some disable directive; **31** of those
carry a bailout-triggering one, at **38** sites; and **15** of those 31 hide findings underneath
them. `react/set-state-in-effect` is the rule with a consequence outside this issue — it is still
burning down in #4407, and its remaining count there is **understated by seven**: seven
violations that exist and are not being counted because the files holding them are not being
scanned. #4407 has a comment saying so now.

This is the canonical measurement — the config comment and the test-suite docblock both point
here instead of repeating the breakdown, so there is one place to re-derive instead of three to
keep in sync. Re-measured 2026-08-29 against a review note that these figures had nothing keeping
them honest; the commands below reproduce every number above. All were run from the repo root with
the pinned `node_modules/.bin/oxlint` (1.79.0):

1. **1858** lintable files, and **38** bailout sites in **31** files:
   `node_modules/.bin/oxlint -c .oxlintrc.json -f json .` → its `number_of_files` field is 1858;
   its `diagnostics` array has 38 entries with `"code": "react(rule-suppression)"`, spanning 31
   distinct `filename`s.
2. **172** files carrying any disable directive (not just a bailout-triggering one):
   `grep -rlE -e 'oxlint-disable' -e 'eslint-disable' --include='*.ts' --include='*.tsx'
   --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.cjs' --exclude-dir=node_modules
   --exclude-dir=dist --exclude-dir=coverage --exclude-dir=src-tauri --exclude-dir=.git .`, minus
   the three files under `ignorePatterns` in `.oxlintrc.json` that a plain directory-name grep
   doesn't know to skip (`src/lib/bindings.ts`, `src/editor/emoji-data.generated.ts`,
   `public/pdf.worker.min.mjs`) — 172.
3. **15** files hiding findings, **40** hidden findings (32 `react/refs`, 1
   `react/static-components`, 7 `react/set-state-in-effect`): there is no single-command way to
   measure this — it is a diff, not a count. Copy the tree to a scratch dir (never mutate the
   working tree in place for a measurement like this), blank out exactly the 38 directive lines
   found in step 1 (replacing each with an empty line, so nothing else shifts), re-run the same
   `oxlint -c .oxlintrc.json -f json .` over the copy, and diff the two JSON diagnostic sets per
   file on `(code, line)`. Findings present in the unmasked run but absent from the original are
   the hidden ones. 15 files gain at least one; the gains sum to 40.

That 40 is **one less** than the 41 (33/1/7) this section used to state. The gap is a documented
oxlint quirk, not a code change: two of the `react(refs)` sites this measurement dedups by
`(file, line)` each carry two diagnostics on the exact same span with different labels (e.g.
`src/hooks/useExtraBlockProperties.ts:118` reports both "Passing a ref to a function may read its
value during render" and "Cannot access ref value during render" at the identical offset) — the
same per-span multi-emission behaviour `oxlint-react-compiler-suppression.test.ts` already dedups
by `(file, code, line)` for exactly this reason. Deduping by line collapses that pair to one; a
finer key that also split on label gave 34, not 33, and a key on the raw `(offset, length, label)`
tuple gave 35 — none reproduce the original 33 exactly, which is itself a sign that "33" was a
count of something slightly different (possibly a manual read, or a since-drifted tree) rather
than a bug in this re-measurement. 40 is what the commands above reproduce; use them to re-derive
it rather than trusting either number by eye.

## `error` is unreachable, and not as a matter of taste

The obvious response is `"react/rule-suppression": "error"`. It cannot land. All 38 sites fail at
once, and the findings underneath them **cannot be suppressed in advance**: add a `react/refs`
disable to a bailed-out function and it is reported UNUSED, because the finding it covers is not
being produced — and both `npm run lint` and the prek `oxlint` hook pass
`--report-unused-disable-directives-severity=error`.

That is a genuine deadlock, not a transitional state, and it is worth naming as a shape: a
suppression and the finding it suppresses can each be an error *conditional on the other's
absence*, and then neither can be added first.

`warn` is what ends the silence. Every bailed-out function is named on every run, so "zero
findings" can be told apart from "not scanned" — which is the whole of what #4493 was actually
about, once the premise was corrected.

## Pinning a behaviour I do not control

The bailout lives in a dependency, so the regression I care about is an oxlint **bump** quietly
lifting it. That is not a nuisance failure to route around: the moment it lifts, the tree's 15
masked files produce the 33 `react/refs` / `react/static-components` errors counted above at sites
carrying no suppression, and by the argument above the suppressions must land in the *same commit*
as the bump.

The test drives the real `oxlint` binary against fixtures in a temp dir, with this repo's own
config, and asserts **both directions**: the finding fires with no directive present, and the same
fixture with an unrelated directive added reports nothing. A one-armed assertion here could not
tell the current behaviour from a fixed one — "no findings" is exactly what a green fixture looks
like either way, which is the same confusion the issue is about, reproduced inside its own test.

One implementation note worth keeping: `oxlint` exits 1 when it reports errors, so `execFileSync`
throws on precisely the fixtures that are supposed to produce findings. The status code is not the
signal; the JSON on stdout is. Reading the exit code here would have made the positive arm
unwritable.

## The docblock that was waiting for a fix that is not coming

`useListStyles.ts` carried a note saying #4493 held the details, deliberately kept out of the
file because "the moment #4493 is fixed a detailed account of the current behaviour becomes a
wrong one". That reasoning was sound and its premise was false — the behaviour is permanent, so
the account belongs in the file. It also promised that a fix "must add the `react/refs`
suppressions here in the SAME commit"; that is still true, but the trigger is an oxlint bump, not
a fix of ours, so the sentence now says which.

## Verification

The new suite: 5 cases, green. `tsc -b` clean; `oxlint` and `oxfmt --check` clean on the changed
files.

Falsified against a copied backup, restore proven byte-identical with `cmp`: setting
`react/rule-suppression` to `off` reddens **2 of the 5** arms — the two masked cases, which assert
that the bailed-out function is NAMED and not merely silent. I had written "the config-reading arm
and nothing else" here before running it, which was a guess and was wrong in a way worth keeping
visible: the config value is not read by one arm, it is what makes the masked arms
*discriminating*. Without it they would assert "no `react/refs` reported" — true of a masked
function and true of a clean one, i.e. an assertion that cannot fail for the reason it exists.
The three that stay green are the no-directive positive control, the unrelated-rule negative
control, and the file-scope arm — all three assert on `react/refs` output, which the flip does
not touch.

Closes #4493.
