# Session 1783 — the frontend mutation lane measures nothing, and now says so

#5101 records a defect in the measuring instrument rather than in the code it
measures: `node scripts/run-mutation.mjs <module>` reports every mutant on every
module as survived, regardless of how good the tests are.

The maintainer's call was to leave the lane running and document it. This is
that documentation, and nothing else — no config change, no skipped job, no
dependency move.

## What is broken

`@stryker-mutator/vitest-runner@10.0.0` reuses one vitest context across mutant
runs and resets it with `this.ctx.state.filesMap.clear()` — a line whose own
comment calls itself "kind of a hack". vitest 5 reworked that state, so after
the clear `ctx.start()` no longer re-collects. Only the first run in a worker
process executes anything:

- the dry run works, being first;
- **static** mutants work, because Stryker reloads the environment and gets a
  fresh process — those are the only kills anywhere;
- every reused run executes zero tests.

The clear-text reporter states it plainly every time: `Ran 0.00 tests per mutant
on average.` The "Tests ran" column is the coverage-derived *selection*, not
what executed, which is why this reads as a coverage gap and is not one — it
produces 0 killed **and** 0 no-coverage at once, which an ordinary gap cannot.

Reproduced here on `tokenize`, not on the module that drew attention:

```
$ STRYKER_MODULE=tokenize npx stryker run --mutate 'src/lib/search-query/tokenize.ts:1-80' \
    --reporters clear-text --concurrency 1
Instrumented 1 source file(s) with 1 mutant(s)
Initial test run succeeded. Ran 24 tests in 0 seconds
Ran 0.00 tests per mutant on average.
All files  |   0.00 |    0.00 |  0 killed | 0 timeout | 1 survived | 0 no cov | 0 errors
```

The warning says "effectively every mutant, all but the static ones" rather
than "every mutant": a reader who runs an enrolled module with module-scope
literals sees a non-zero score and some kills, and a warning contradicted by
what is on their screen is one they will discount.

`glob-validate` is where this is most visible only because it is all functions
with no module-scope literals, so it has no static mutants to accidentally kill.
Modules with top-level arrays score a few percent instead of zero. Same bug,
different denominators.

## What was ruled out

The standing hypothesis was that `glob-conformance.test.ts`'s top-level
`readFileSync` throws because its fixture is missing from Stryker's sandbox,
taking the module's run down. That is wrong:
`conformance/pages-metadata/path-glob.vectors.json` is tracked, is not in
`ignorePatterns`, and is present in `.stryker-tmp/sandbox-*/`; `--dryRunOnly`
instruments 307 mutants and runs 65 tests. Had the fixture been missing, the dry
run would have failed and there would be no report at all.

The suite is not weak either. `glob-validate.test.ts` is 296 lines and its cases
are pointed — `']a['` exists specifically to kill the "count mismatch masks a
premature close bracket" mutant.

## Why nothing else changed

There is no bump to take: 10.0.0 is the newest published runner, its peer range
is a permissive `>=2.0.0` against its own devDependency of `vitest@4.1.10`
(which is why `npm ci` never complained), and `AGENTS.md` § "Coupled Dependency
Updates" pins the two Stryker packages to each other exactly, so there is no
partial bump either.

Nothing has ever gated wrongly on this: `scheduled-deep-checks.yml` wraps the
lane in `|| true` and there is no `thresholds.break`.

The cost does not fall only on whoever goes looking at the numbers.
`scripts/file-mutation-survivors.mjs` runs once per mutants lane, the frontend
lane among them, and keeps a rolling tracking issue plus one child per area. The
phantom survivors are therefore *pushed* at people: **#3766** ("Mutation
survivors — frontend: vault-import") is open right now under parent **#4691**,
listing four survivors in `src/lib/vault-import.ts` that were never alive, and
it is re-rendered weekly. `mutation-pr.yml` posts the same class of finding as a
sticky comment on a contributor's own PR.

So the warning had to reach where the numbers are read, not only where the
command is documented, without spreading so far that #5101's eventual fix has
to hunt every copy — a warning left behind after the lane works again is a doc
that lies. Three files. `AGENTS.md` § "Acceptance is falsification", where the
command is recommended, on explicit maintainer instruction. `docs/BUILD.md` §
"Mutation testing (nightly)", the recipe `AGENTS.md` sends people to, which
still described a survivor as "a gap in assertion *strength*" — a blockquote
there, plus a clause on the per-PR-lane paragraph whose stated purpose is
attribution of survivors that do not exist. And the doc header of
`scripts/run-mutation.mjs`, for a reader who opens the command rather than the
docs.

One read point is still uncovered. `mutation-pr.yml`'s sticky comment reaches a
contributor who never opens either page, and `docs/BUILD.md`'s clause about that
lane only helps someone already reading `docs/BUILD.md`. Covering it means
changing `render-mutation-summary.mjs`, which is a behaviour change rather than
documentation, so it is left with the auto-filed issues for the maintainer.

Pinning vitest 4.x for the lane alone was considered and declined: it would
score mutants against a runtime neither CI nor development uses.

The Rust lane (`cargo mutants --workspace`) shares none of this machinery and is
unaffected.

## Verified

`scripts/run-mutation.mjs` still resolves its module list. Every edit is a
comment or prose; no behaviour changed, so there is nothing to falsify.
