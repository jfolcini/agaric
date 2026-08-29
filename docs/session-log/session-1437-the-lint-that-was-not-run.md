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
version actually resolved by `package-lock.json` and installed at `node_modules/.bin/oxlint`,
which is the binary actually checked here. `package.json` itself declares
`"oxlint": "^1.79.0"`, a caret range: `npm install` can move that forward to 1.80.x without
touching `package.json` at all, so the pin this whole regression story depends on lives in the
lockfile, not there — only `npm ci`, which honours the lockfile, reproduces the version checked
below. (A newer 1.80.0 exists upstream; it is not what this repo runs, and an earlier draft of
this note cited it by mistake.) And no key in `.oxlintrc.json` switches it off.
So the thing #4493 asked to fix is not a bug and not configurable; the only variable left is
whether the silence is **visible**.

## The measurement, with its denominator

Of **1858** lintable files in the tree: **170** carry some disable directive; **31** of those
carry a bailout-triggering one, at **38** sites; and **15** of those 31 hide findings underneath
them. `react/set-state-in-effect` is the rule with a consequence outside this issue — it is still
burning down in #4407, and its remaining count there is **understated by seven**: seven
violations that exist and are not being counted because the files holding them are not being
scanned. #4407 has a comment saying so now.

This is the canonical measurement — the config comment and the test-suite docblock both point
here instead of repeating the breakdown, so there is one place to re-derive instead of three to
keep in sync. **Point-in-time as of 2026-08-29 at commit `01b5724f2`** — nothing re-runs this
automatically (see "Whether this should self-check" below), so re-derive these numbers with the
commands below before trusting them on a tree that has moved since. All were run from the repo
root with the pinned `node_modules/.bin/oxlint` (1.79.0):

1. **1858** lintable files, and **38** bailout sites in **31** files:
   `node_modules/.bin/oxlint -c .oxlintrc.json -f json .` → its `number_of_files` field is 1858;
   its `diagnostics` array has 38 entries with `"code": "react(rule-suppression)"`, spanning 31
   distinct `filename`s.
2. **170** files carrying any disable directive (not just a bailout-triggering one). A previous
   version of this recipe used a plain multi-extension `grep -l`, on the theory that a disable
   directive is always a `//` or `/* */` comment naming `oxlint-disable` or `eslint-disable`. That
   theory is false: `grep` matches *text*, not *comments*, and this repo has two files where the
   same text appears as fixture/generator DATA rather than as a directive —
   `src/__tests__/oxlint-react-compiler-suppression.test.ts` (this suite's own fixtures embed
   `// oxlint-disable-next-line ...` inside template literals to prove the bailout fires, and one
   test description contains the string `` `oxlint-disable` `` in prose) and
   `scripts/generate-emoji-data.mjs` (which emits `emoji-data.generated.ts`'s
   `/* oxlint-disable */` line as a string literal it writes to disk). A `grep -l` run from this
   PR's branch counts its own test file as "directive-carrying" — the measurement counting its own
   apparatus — which is exactly the kind of drift a number nobody re-derives will not catch.

   The repo already has a real lexer for exactly this job:
   `scripts/lib/js-scanner.mjs`'s exported `blankStringsAndTemplates()`, which replaces
   string/template-literal *contents* with equal-length whitespace while leaving real comments (and
   template `${…}` interpolated code) intact. It is reachable from a doc recipe — it's a plain
   ESM export, not a CLI wrapped around one — so the corrected recipe uses it instead of pretending
   a bare grep is precise:

   ```sh
   grep -rlE -e 'oxlint-disable' -e 'eslint-disable' --include='*.ts' --include='*.tsx' \
     --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.cjs' \
     --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage \
     --exclude-dir=src-tauri --exclude-dir=.git . > /tmp/candidates.txt

   node --input-type=module -e '
     import { readFileSync } from "node:fs"
     import { blankStringsAndTemplates } from "./scripts/lib/js-scanner.mjs"
     const files = readFileSync("/tmp/candidates.txt", "utf8").trim().split("\n").filter(Boolean)
     const ignored = new Set([
       "src/lib/bindings.ts",
       "src/editor/emoji-data.generated.ts",
       "public/pdf.worker.min.mjs",
     ])
     const real = files.filter((f) =>
       /oxlint-disable|eslint-disable/.test(blankStringsAndTemplates(readFileSync(f, "utf8"))),
     )
     console.log(real.length, "real directive-carrying files")
     // grep -r . prefixes every path with "./"; strip it before the Set lookup,
     // or every ignorePatterns entry silently fails to match and nothing gets
     // subtracted.
     console.log(
       real.filter((f) => !ignored.has(f.replace(/^\.\//, ""))).length,
       "after removing ignorePatterns files actually present",
     )
   '
   ```

   `grep` still finds the *candidates* (fast, and a superset is safe here); `blankStringsAndTemplates`
   then decides which of them carry a directive in an actual comment, which drops both false
   positives above automatically — by construction, not by naming them, so a third file that
   embeds directive-shaped fixture text later is excluded too without anyone updating an exclude
   list. That leaves **171** files with a real directive (printed by the script's first line). Only
   one of the three `ignorePatterns` files in `.oxlintrc.json` is ever in that result —
   `src/editor/emoji-data.generated.ts`, which has a genuine `/* oxlint-disable */`;
   `src/lib/bindings.ts` and `public/pdf.worker.min.mjs` contain no disable directive at all, in a
   comment or otherwise, so they were never in any result set to subtract from. Subtracting the one
   that IS present (checked, not assumed) aligns the count with oxlint's own 1858-file scanned
   population, since that file is excluded from it by `ignorePatterns`. **170** (the script's second
   line). Run against `main` — no `oxlint-react-compiler-suppression.test.ts` there, so no
   self-counting; the only false positive is `generate-emoji-data.mjs` — the same corrected recipe
   also yields **170**, which is what makes 170 usable as a stable figure: it no longer depends on
   which branch happens to be checked out.
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

## Whether this should self-check

De-duplicating the figures above to this one file is an improvement, but it is not a guard: nothing
re-runs the recipes and fails a commit or a CI run if the tree has drifted since 2026-08-29. Note 1
above is not a hypothetical case for why that matters — the recipe drifted from what it claimed
*inside this same PR*, and the number that will actually cost something if it drifts silently is
the `react/set-state-in-effect` under-count feeding #4407 (seven today).

I measured rather than assumed the cost of closing that gap. Step 1 (`oxlint -f json .` once) is
~0.8s wall-clock on this tree. The full step-3 method — `rsync` a working copy (~1.2s for the ~70MB
tree excluding `node_modules`/`.git`/`dist`/`src-tauri/target`), blank the 38 directive lines,
re-lint the copy (~1s) — adds up to roughly 3s total, which is not the "slow for a pre-commit hook"
I expected going in; a bare double-lint is cheap. That is not the whole cost, though: a guard
worth having would need to reimplement step 3's masking-and-diff logic (find the 38 sites, blank
exactly those lines without shifting anything else, re-lint, diff two JSON diagnostic sets per
`(file, code, line)`, compare the resulting 15/40/7 against checked-in numbers) as a maintained
script with its own tests — new code roughly the size of, or larger than, the fix in this PR,
introduced into the same `prek` pipeline whose fragility is a recurring cost here (ratchet
baselines, path-keyed guards breaking on refactors). That is a real piece of engineering, not a
few-line addition, and building it is out of scope for a PR about documentation accuracy.

Given that, I did not build the guard. What ships instead: every figure in this file, in
`.oxlintrc.json`, and in the test docblock is now stated as a **point-in-time measurement** — dated
and pinned to the commit it was taken at — so a reader who cares whether it still holds knows to
re-run the commands above rather than trust the prose. My recommendation, for a human to decide on
rather than something I'm filing as an issue: if the drift risk is worth closing, it is a
follow-up worth scoping deliberately (most likely as a periodic/weekly check in the style of the
bench-smoke jobs, not a per-commit `prek` hook, given the file-copy step), not something to fold
into this PR.

## Verification

The new suite: 6 cases, green (verified 2026-08-29: `npx vitest run
src/__tests__/oxlint-react-compiler-suppression.test.ts` → 6 passed). `tsc -b` clean; `oxlint` and
`oxfmt --check` clean on the changed files.

Falsified against a copied backup, restore proven byte-identical with `cmp`: setting
`react/rule-suppression` to `off` reddens **2 of the 6** arms — the two masked cases, which assert
that the bailed-out function is NAMED and not merely silent. I had written "the config-reading arm
and nothing else" here before running it, which was a guess and was wrong in a way worth keeping
visible: the config value is not read by one arm, it is what makes the masked arms
*discriminating*. Without it they would assert "no `react/refs` reported" — true of a masked
function and true of a clean one, i.e. an assertion that cannot fail for the reason it exists.
The four that stay green are the no-directive positive control, the unrelated-rule negative
control, the file-scope arm, and the multi-file arm added later for review note 1 on #4493 — all
four assert on `react/refs` output, which the flip does not touch. (Re-verified 2026-08-29: `npx
vitest run` on the copy reports 4 passed / 2 failed, matching this breakdown.)

Closes #4493.
