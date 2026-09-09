# Session 1637 — review notes from #4891, #4892 and #4893

Six non-blocking notes, batched per AGENTS.md § How we work: an approved green PR
merges as it stands and its notes come back in one follow-up. Four held, one was
withdrawn before it was worked, and one turned out to be wrong in a way that is
worth writing down.

## The 37 comparators

#4892 cleared `require-array-sort-compare` by writing `(a, b) => (a < b ? -1 : a
> b ? 1 : 0)` out 37 times across 17 script files. `main` had none. The note
offered two remedies — one shared exported comparator in `scripts/lib/`, or a
JSDoc type on the declarations — and asked for a per-site judgement rather than
one mechanical sweep.

The judgement came out the same way at every site: annotate. The rule ignores an
array typed `string[]`, so stating the type is enough, and stating the type adds
no runtime code at all. What made it unanimous is that the type was always
available at a *source*, not just at the sort. Nearly every one of these arrays
and sets is built a few lines above the `.toSorted()` that flagged it — `const
out = []` filled with `path.join(...)`, `const offenders = []` filled with
repo-relative paths, `const badTiers = new Set()` filled with tier names — so
one `/** @type {string[]} */` or `/** @type {Set<string>} */` on the declaration
clears every derived sort downstream of it. Two of
`check-json-parse-cast`'s three diagnostics fall to one `offenders`;
`check-tauri-mock-parity`'s three need three declarations — `expected`, `mocked`
and `KNOWN_UNMOCKED`.

Where the value arrives as a parameter there is nothing to annotate at the
declaration, and there the annotation is a `@param`: `diffFindings`,
`diffSurvivors`, `diffLanes`, `diffSets` and `writeBaseline` all take a
`Set<string>` or a `string[]` they only ever read as strings, and saying so is
documentation the file wanted anyway. Two functions were better fixed at their
own source than at their callers: `readBaseline` in
`check-migration-test-coverage` gained a `@returns {Set<string>}` because its
`if (!existsSync(path)) return new Set()` early arm made the union untypeable
from the outside, and `listTrackedEntries` in `scripts/lib/guard-file-source.mjs`
gained a `/** @type {string[]} */` on its `paths` accumulator, which is what
`git-scratch-guard.mjs`'s `entries.paths.toSorted()` two files away was missing.

Three sites are not a plain declaration. `check-metric-provable`'s self-test
sorts `[...new Set(live.metrics.map((m) => m.file))]` inline, and took a JSDoc
cast on the receiver — the same idiom #4892 used for its two `Array<{ key:
string }>` casts. `file-mutation-survivors`'s `selfTestChildGh` spelled
`created.map((c) => c.title)` twice; it now binds it once, annotated, and both
uses read the binding. Neither adds a statement that runs.

So: **zero hand-written copies of that ternary remain under `scripts/`**, and no
shared comparator module was added. The note's second remedy would have been the
right one if annotation had been dishonest anywhere, and it was not — every one
of these arrays holds strings at runtime, which #4892 had already established and
this change only writes down. The two named comparators that survive,
`src/lib/agenda-sort.ts:43` and `src/lib/tauri-mock/handlers/shared.ts:650`,
predate #4892 and are untouched.

`scripts/pr-diff-base.test.mjs` keeps the `localeCompare` #4892 gave it. It is
not one of the 37, its input really is `string | undefined`, and rewriting a
merged decision that nobody flagged is not what a notes PR is for.

## Two corrections to session 1635

Session logs are immutable once merged, so these are recorded here rather than
edited into 1635.

**1635 credits three casts it did not make.** Its `no-misused-spread` section
says three `/** @type {[string, string[]][]} */` loop-head casts in
`check-metric-provable.mjs` "gi[ve] the checker the tuple it should have had",
presented as #4892's work. All three are already present at #4892's merge base:
`git show d9d054d2e^:scripts/check-metric-provable.mjs` finds them at lines 2977,
3851 and 3948, and `git log -S` puts them in #4889. #4892's own hunks in that
file are the three sort comparators and nothing else. The five spread sites
#4892 actually changed are the three `Array.from(str)` rewrites and the two
`window.location` disables.

**1635's issue pointer had no number.** "The disagreement itself is not fixed
here … Filed as its own issue" is
[#4894](https://github.com/jfolcini/agaric/issues/4894) — `npm run lint` is
weaker than the prek hook on `scripts/**/*.mjs`. AGENTS.md § Testing asks for the
number rather than the phrase, for exactly the reason that finding it again cost
a review round.

**And a third, which the notes did not ask for.** 1635 says the whole-tree walk
"reports NO type-aware diagnostic for any file under `scripts/`". Measured
against the pre-#4892 content of all 18 files, the walk reports **33**
`require-array-sort-compare` errors under `scripts/`; naming the same files
explicitly reports **35**. The three sites 1635 lists as named-only are real —
`check-main-module-detection:408`, `check-metric-provable:1467` and
`git-scratch-guard:264` are in the 35 and not in the 33 — but the walk is not
silent, and the disagreement runs in *both* directions:
`file-mutation-survivors.mjs:3415` is in the 33 and not in the 35. That site is
why reverting all 37 comparators reddened `npm run lint` while the strict
named-file run stayed green, which is how the asymmetry surfaced. It sharpens
#4894 rather than changing it: the two entry points do not differ by strictness,
they differ by which files each one manages to resolve type information for.

## The `shared.ts` comment, and two reviewers pulling opposite ways

`propertyLikeMatches` carried a five-line comment, four of them on what happens
if a non-string reaches `value_text`. One reviewer asked for the caveat to go —
that state is unreachable through the typed boundary, and AGENTS.md § How we work
says not to engineer for speculative situations. An earlier reviewer on the same
PR had asked for it to be *there*, because `asciiLowercase(stored as string)` is
not runtime-identical to the `String()` it replaced: `asciiLowercase` is a
`.replace`, which throws on a non-string where the coercion absorbed it.

Both are right about their own half, so the comment now states the reason once
and keeps the consequence as a subordinate clause: `value_num` is excluded above,
so the remaining columns are all TEXT, which is what `asciiLowercase` needs — it
is a `.replace`, not a coercion. Two lines. The unreachable state is gone; the
fact that the cast is load-bearing for a `.replace` survives, because that is the
thing a reader would otherwise delete as redundant with the `String()` three
lines down.

## The `void` that is not decorative

The last note called the `void` in `RichContentRenderer.test.tsx`'s parse-cache
tests decorative — the value is not a promise, so a bare call statement discards
the node identically — and asked for it and its comment to go.

It does not hold, and the note named its own falsifier: `npm run lint` exiting 0.
With the three `void`s dropped, `oxlint --type-aware` reports six
`typescript(no-floating-promises)` errors. React 19 types `ReactNode` as a union
that includes `Promise<AwaitedReactNode>`, so a call statement returning one is a
floating promise as far as the rule is concerned, whatever it does at runtime.
It is a `correctness` rule and that category is `error`; #4890 is what made it
report at all, by passing `--type-aware` from both entry points. So this is a red
build, not a warning.

The `void`s stay. The comment stays too, but it now says the load-bearing thing
instead of the obvious one: it records *why* `void` and not a bare call, so the
next reader who notices that the value is not really a promise has the answer
before they delete it. That is the whole reason the comment earns its place.

## Note 4, withdrawn

The one remaining note asked for the three-line `ClassMethodBinder` paragraph copy-pasted
into four jsdom-pinned test files to be trimmed to one line each plus a pointer
to `src/__tests__/AGENTS.md`. It was withdrawn mid-session: the maintainer is
having the spies themselves fixed rather than worked around —
`vi.spyOn(window.localStorage, …)` goes through the proxy's `defineProperty`
trap, which calls `preventBinding`, so the first-touch freeze cannot reach an
instance spy — and those four files are about to lose the
`// @vitest-environment jsdom` pin and the paragraph with it. Re-wording a
comment that is being deleted is work thrown away. The four files are untouched.

## Verification

`npm run lint` exits 0 and so does `npx oxlint --type-aware` over every
`scripts/**/*.mjs` named explicitly; both matter, because as measured above
neither is a superset of the other. `npm run typecheck` is clean.
`npx vitest run src/components/__tests__/RichContentRenderer.test.tsx` passes 100
tests.

The guards were checked as behaviour. Seven have a `--self-test` and all seven
pass — `check-main-module-detection`, `check-metric-provable`,
`check-persist-hooks`, `check-types-erasure`, `check-unanchored-content-regex`,
`file-mutation-survivors`, and `check-doc-code-paths`, which is the one that
drives `git-scratch-guard.mjs`'s `verifyIndexFraming` and through it
`listTrackedEntries`, so it reaches the `guard-file-source.mjs` change.
`check-remove-after-markers --self-test` and `scripts/test-py-guard-file-source.sh`,
the other two consumers of that module, pass as well. The seven guards without a
self-test run green against the live tree.

Better than green: regenerating `json-parse-cast`, `lib-layering`,
`tauri-import` and `migrations-test-coverage`'s baselines through
`--update-baseline` reproduces each committed file byte for byte, which tests the
ordering claim rather than arguing it. `bulk-equivalence`'s baseline does not
round-trip, and 1635 says that is pre-existing; that was re-checked here rather
than taken on trust, by regenerating it twice — once with this branch's script,
once with the pristine `HEAD` one — and `cmp`-ing all three files. The committed
file differs from both, the two regenerated files are identical to each other.
Pre-existing, and this change moves nothing.

`file-fuzz-findings`, `file-scheduled-failures` and `check-workflow-liveness`
have no self-test and their CLIs file GitHub issues, so `diffFindings`,
`reproducersFor`, `diffLanes` and `findUnwatchedWorkflows` were driven directly
on inputs whose code-unit order differs from their locale order — uppercase,
lowercase, a leading `_` and a leading digit — asserting the code-unit order and
asserting that the two collations disagree on that input, so the assertion is not
satisfiable by either one.

Every measurement above that needed a modified tree was taken against `cp`
backups and restored with a `cmp` check in the same command, so the working tree
never held a reverted guard past the end of a single invocation.
