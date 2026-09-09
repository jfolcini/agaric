# Session 1635 — clearing require-array-sort-compare and no-misused-spread

`oxlint --type-aware` had never blocked anything in this tree — it ran weekly,
reporting-only, in `scheduled-deep-checks.yml`, and #4890 moved the flag into
`npm run lint` and the `oxlint` prek hook. The twelve rules it brings were
cleared one at a time; these two are the last, 42 and 5 sites, and this PR also
promotes them from `warn` to `error`, which completes the burn-down.

## Nothing was sorting numbers

`require-array-sort-compare` exists because `[10, 9, 1].sort()` is `[1, 10, 9]`,
so the first thing to establish was whether any flagged site was a latent
numeric sort. None is. The rule ignores arrays whose element type is `string`,
which means every one of the 42 sites was flagged for a *type* reason rather
than a value one: an `any[]` in an unannotated `.mjs` (a `Set` iterated into an
array, a `const x = []` accumulator), or a union — `string | undefined` from
`.at(-1)` and an optional property, `string | null` from `getAttribute`,
`unknown` from an index signature, `[string, number]` from `Map#entries`. At
runtime all 42 hold strings: file paths, migration numbers (zero-padded, so
lexicographic *is* numeric here), command names, tag names, survivor ids, job
names, issue titles. **No ordering changed anywhere in this diff.**

That made the comparator choice a matter of stating the existing intent, not
picking a new one. The `.mjs` guard and filer scripts got
`(a, b) => (a < b ? -1 : a > b ? 1 : 0)`, which is the default comparator for
string arrays by definition. `localeCompare` was rejected rather than assumed
away: a 20 000-case random check over an alphabet of letters in both cases,
digits, `-`, `_`, `/`, `.`, `:`, space and an astral emoji shows the code-unit
comparator agreeing with the bare `.sort()` on every input, and reddens
immediately when the comparator is swapped for `localeCompare`. Half of these
arrays are written straight into committed baseline files, so a collation change
would have been a diff on every one.

The exception is `check-bulk-equivalence.mjs`, where `stale`'s five siblings in
the same return object already sort by `localeCompare`. It keeps the code-unit
comparator anyway: matching the neighbours is cosmetic, and the two orders are
not the same function.

Eight sites are test assertions in `src/`, where the sets are two to four ASCII
tokens pinned by the assertion on the next line, so `localeCompare` is provably
the same order and reads better than a nested ternary. Two of those unions were
better removed than coalesced: `useQueryExecution.test.ts` and
`agenda-filters.test.ts` each cast an IPC payload to `Record<string, unknown>`
and then read one known key out of it, so the casts are now
`Array<{ key: string }>` and `Array<[string, { prefix: string }]>` — the sort is
a string sort and needs no comparator at all. `resolve-store-title-seed-parity`
sorts `Map` entries; those go through `Object.fromEntries` into a `toEqual`,
which ignores key order, so the sort is there for the failure diff and now says
so by sorting on `a[0]`.

## `no-misused-spread`

Three of the eight are `[...str]` on a deliberate code-point split, all three
carrying a comment saying so — `isMatchableKeyToken`, the palette content cap in
the mock's search handler, and the test that pins that cap at 512 code points.
`Array.from(str)` uses the same string iterator and is exactly equivalent, so
those are one-token changes.

Three more are in `check-metric-provable.mjs`'s self-test and were a real, if
harmless, type confusion. `for (const [label, lines] of [['a', ['x']], …])`
infers the literal as `(string | string[])[]`, not as tuples, so `lines` is
`string | string[]` and `test(...lines)` looked like a string spread. A JSDoc
`/** @type {[string, string[]][]} */` cast on each of the three loop heads gives
the checker the tuple it should have had.

## The two disables

`ErrorBoundary.test.tsx` and `relaunch-app.test.ts` both stand in for
`window.location` with `{ ...window.location, reload: reloadMock }` so the
degradation path can assert `reload()` was called. The rule is right that this
loses the `Location` prototype, and there is no shape that keeps it: jsdom's
`Location` has non-configurable own properties, so `defineProperty` and
`vi.spyOn` on `reload` both throw, and its accessors are brand-checked, so an
`Object.create(window.location, …)` wrapper throws on the first `href` read. A
detached snapshot is the only stand-in that works, and losing the prototype is
the point of it. Both carry a narrow `oxlint-disable-next-line` naming that
reason. They are the only two suppressions in the change.

## Verification

Both rules report zero under `oxlint --type-aware`; plain `oxlint` still has no
errors, so neither disable directive is reported as unused. `npm run typecheck`
is clean.

The scripts carry the weight of the diff, so they were checked as behaviour,
not as a diff. `check-bulk-equivalence`, `check-json-parse-cast`,
`check-lib-layering`, `check-metric-provable`, `check-migration-test-coverage`,
`check-persist-hooks`, `check-tauri-import-baseline`, `check-tauri-mock-parity`,
`check-tsc-root-files`, `check-types-erasure` and
`check-unanchored-content-regex` all run green against the live tree, and the
five that have a `--self-test` pass it. Better than that: regenerating
`json-parse-cast`, `lib-layering`, `tauri-import` and
`migrations-test-coverage`'s baselines through `--update-baseline` reproduces
the committed files byte for byte, which is the ordering claim tested directly
rather than argued. `bulk-equivalence`'s baseline does not round-trip, but it
does not round-trip on `origin/main` either — the committed file escapes its em
dashes and omits entries the current scanner finds — and
the file this branch produces is `cmp`-identical to the one the pristine script
produces. Pre-existing drift, not this change's.

`file-fuzz-findings`, `file-scheduled-failures` and `check-workflow-liveness`
have no self-test and their CLIs file GitHub issues, so `diffFindings`,
`reproducersFor`, `diffLanes` and `findUnwatchedWorkflows` were driven directly
on inputs whose expected order distinguishes the two collations.
`file-mutation-survivors` is covered by its own `--self-test`, which reaches
`diffSurvivors` and `applyAcceptedGaps`.

`node --test scripts/pr-diff-base.test.mjs` passes, as do the twelve vitest
files covering every touched `src/` path, including both `window.location`
tests — which are self-falsifying for the disable, since they assert the mock
was called and would fail outright if the stand-in stopped carrying it.

## Both rules promoted to `error`, and the burn-down is done

With these two at zero, all twelve type-aware rules are enforced. `.oxlintrc.json`'s
type-aware block shrinks to what is still true: the two lines this PR promotes,
and one sentence saying the other ten reach `error` through the `correctness`
category (bar `only-throw-error`, which spells out its `allow`). The 25 lines of
burn-down narrative that block carried were a description of a state that no
longer exists — AGENTS.md § "Say it once", and git history holds the rest.

Both promotions were falsified with a throwaway probe file rather than by
mutating a real one, so there was no window in which the tree held a disabled
fix: a `[...'héllo']` and a `toSorted()` on a `number[]` each red `npm run lint`
at `error` and exit 1, the probe was deleted, and the run returned to 0 with no
untracked file left behind. The first attempt used `.sort()` and proved nothing
— `unicorn/no-array-sort` claims that syntax first — and the second used an
untyped parameter, which the rule ignores because it is `any`. Only the third
probe exercised the rule under test.

## `npm run lint` and the prek hook do not agree on `scripts/**/*.mjs`

Promoting the two rules to `error` surfaced this, and it is the most useful
thing the PR found.

`npx oxlint --type-aware` walking the whole tree reports **no** type-aware
diagnostic for any file under `scripts/`. Naming those same files explicitly
reports three:

```
scripts/check-main-module-detection.mjs:408   require-array-sort-compare
scripts/check-metric-provable.mjs:1467        require-array-sort-compare
scripts/lib/git-scratch-guard.mjs:264         require-array-sort-compare
```

Non-type-aware rules are unaffected — the whole-tree run reports `eslint/complexity`
in those same files — so the walk reaches them; it is the type information that
does not.

That matters because the two entry points differ in exactly this way. `npm run
lint` walks the tree. The `oxlint` prek hook has `pass_filenames = true`, so it
names files, and CI runs `prek run --all-files`, which names all of them. **CI
and the commit hook are the strict pair; `npm run lint` is the lenient one.**
While both rules sat at `warn` the difference printed as warnings and cost
nothing; at `error` the commit hook rejects what `npm run lint` had just called
clean, which is how this was found — three green `npm run lint` runs, then an
aborted commit.

The three sites are fixed here. `git-scratch-guard.mjs` took the comparator on
both halves of its `join('\n')` equality check rather than only the flagged one:
two arrays compared for equality have to sort the same way, and one of them was
`any`-typed, which is the only reason the rule did not flag it too.
`check-doc-code-paths --self-test` drives that assertion four times and stays
green.

The disagreement itself is not fixed here — making `lint` name files is a
deliberate change, not a side effect of a sort-comparator PR. Filed as its own
issue.
