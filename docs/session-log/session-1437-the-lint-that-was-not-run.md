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
trust its own inference for that function. It is unchanged in the latest release (1.80.0,
checked). And no key in `.oxlintrc.json` switches it off. So the thing #4493 asked to fix is not
a bug and not configurable; the only variable left is whether the silence is **visible**.

## The measurement, with its denominator

Of **1858** lintable files in the tree: **172** carry some disable directive; **31** of those
carry a bailout-triggering one, at **38** sites; and **15** of those 31 hide findings — **41** of
them. Broken out: 33 `react/refs`, 1 `react/static-components` (both `error` in this config), and
7 `react/set-state-in-effect`.

That last number is the one with a consequence outside this issue. `react/set-state-in-effect` is
the rule still burning down in #4407, and its remaining count there is **understated by seven** —
seven violations that exist and are not being counted because the files holding them are not
being scanned. #4407 has a comment saying so now.

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
masked files produce ~34 `react/refs` / `react/static-components` errors at sites carrying no
suppression, and by the argument above the suppressions must land in the *same commit* as the
bump.

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
