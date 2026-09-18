# Session 1782 — the review notes from a five-PR sweep, and a mutation lane that measures nothing

#5094, #5095, #5096, #5097 and #5099 merged green and approved. This is the
one follow-up PR their non-blocking notes earn between them, per
`AGENTS.md` § "Reviews judge impact": one review round for the sweep instead
of one per PR on work already approved.

Eight notes came in. Three shipped, two were overridden on their own evidence,
two were already recorded as declined and stay declined, and one turned out not
to be a review note at all.

## What shipped

**One comparator for the sibling tiebreak.** `renumberSiblings` and
`insertAtSlotAndRenumber` ordered `(position, id)` with `localeCompare`; the
`move_blocks_to_space` re-rank added in #5099 used `compareUtf8Bytes`. They
genuinely disagree: `SPACE_PERSONAL` against `SPACEX` is `-1` under ICU and
`+1` under bytes, because `_` (0x5F) sorts after `X` (0x58) while ICU files
punctuation first, and `seed.ts` really does seed `SPACE_PERSONAL`.

It is bounded and was never a mock-vs-backend divergence — real ids are ULIDs
(invariant 8) and every id in `conformance/fixtures/` is one, so the two orders
coincide on anything a database can produce. The disagreement lived in the dev
seed alone. That is why #5097 looked at these same two functions and left them:
that analysis stands, and this is internal inconsistency.

The three sites now share `comparePositionThenId`. That changes
`renumberSiblings` / `insertAtSlotAndRenumber` ordering, which nothing pinned,
so it comes with the pin it needed — two arms in
`sqlite-collation-parity.test.ts` seeded in the ICU order, so a dropped sort
reddens as well as a reverted one. Both were watched red against a copy with
the tiebreak reverted (`expected 2 to be 1`, `expected 3 to be 2`), restored,
`cmp` clean.

`blocks.ts` still has three more `(position, id)` tiebreaks on `localeCompare`,
and `revert.ts` has `renumberSiblingsIn`. Same ordering, same ULID bound, left
alone: each is another unpinned behaviour change, and converting them without a
discriminating pin apiece would be exactly the churn this PR is supposed to
batch away.

**Two single-use helpers inlined** in `node-view-mobile-freeze.test.ts`, and
`IgnoreMutationSelf.options.ignoreMutation` narrowed from
`((props) => boolean) | null` to `null` — after #5095 no test passes a
function, so the union described a shape nothing constructs. Test count
unchanged at 10.

**A word at the one ordering site still on `localeCompare`.**
`list_journal_pages_in_range` gates its content to `^\d{4}-\d{2}-\d{2}$`
before the sort, so every compare resolves on a digit pair, where ICU and
`BINARY` agree. #5097's PR body said so; a PR body is not where the next reader
looks.

**The re-rank derivation, cut from four copies to one.** The handler comment and
the fixture op comment both carried the review archaeology — how the in-loop
re-rank handed the list back reversed, why the caveat was restated four times.
The rule is three sentences and now takes three. Every load-bearing fact stays,
including the #5100 source-group paragraph, which is current behaviour rather
than history.

## Two notes overridden

**`identifier(name)` stays.** The note asked to inline it as a single-caller
helper. It has two callers, and its comment records why the matcher is rebuilt
per call rather than hoisted — a shared `/g` regex carries `lastIndex` into
every `matchAll`. Inlining duplicated a regex literal at both sites and deleted
the warning that stops the next person hoisting it. With two callers the note's
disposition does not follow from its premise.

**Android back still does not close an open peek**, and that is where it stays.
The premise is right: `BlockRefPeek` renders a hand-rolled `role="dialog"` with
no `data-state`, so `OPEN_OVERLAY_SELECTOR` misses it and the press falls
through to navigation. Everything downstream already works — the peek listens
for both raw Escape and `CLOSE_ALL_OVERLAYS_EVENT`, and `overlayBackHandler`
dispatches a synthetic Escape that would reach both.

The fix is what makes it not worth doing. `[role="dialog"][data-state="open"]`
has a second consumer: `use-block-tree-keyboard-shortcuts.ts:424` bails out of
zoom-out-Escape while an overlay is open. Giving the peek that attribute would
make the zoom-out guard bail whenever a hover peek is on screen — a desktop
regression traded for a narrow Android one. And the victim is nearly empty:
`handlePointerEnter` returns early on `pointerType === 'touch'`, so on an
Android touch device the peek cannot be opened at all. Reaching this needs
Android plus a stylus, mouse or hardware keyboard, plus an open peek, plus a
back press. No concrete victim, so no fix and no issue.

## The one that was not a review note

`glob-validate` scoring a clean 0.0% — 307 survivors, 0 killed, 0 no-coverage —
is not a property of `glob-validate`. **The whole frontend mutation lane has
been measuring nothing since vitest went to 5.** Filed as #5101.

`@stryker-mutator/vitest-runner@10.0.0` resets its reused vitest context with
`this.ctx.state.filesMap.clear()`, a line whose own comment calls itself "kind
of a hack". vitest 5 reworked that state, so after the clear `ctx.start()` no
longer re-collects: only the first run in a worker executes anything. The dry
run works because it is first. Static mutants work because Stryker reloads the
environment and gets a fresh process — those are the only kills anywhere. Every
reused run executes zero tests, and the reporter says so on every run:
`Ran 0.00 tests per mutant on average`.

Reproduced here on a module that is not `glob-validate`:

```
$ STRYKER_MODULE=tokenize npx stryker run --mutate 'src/lib/search-query/tokenize.ts:1-80' \
    --reporters clear-text --concurrency 1
Initial test run succeeded. Ran 24 tests in 0 seconds
Ran 0.00 tests per mutant on average.
All files  |   0.00 |    0.00 |  0 killed | 0 timeout | 1 survived | 0 no cov | 0 errors
```

The dry run collects and passes 24 tests; the mutant then runs against none of
them. `glob-validate` is the module where this is most visible only because it
is all functions with no module-scope literals, so it has no static mutants to
accidentally kill; modules with top-level arrays score a few percent instead of
zero.

The standing hypothesis — that `glob-conformance.test.ts`'s top-level
`readFileSync` throws because the fixture is missing from Stryker's sandbox — is
wrong. The fixture is tracked, is not in `ignorePatterns`, and is present in
`.stryker-tmp/sandbox-*/`; `--dryRunOnly` instruments 307 mutants and runs 65
tests. Had it been missing, the dry run would have failed and there would be no
report at all.

`vitest-runner@10.0.0` is the newest published, its peer range is a permissive
`>=2.0.0` (so `npm ci` never complained) against its own devDependency of
`vitest@4.1.10`, and the two Stryker packages pin each other exactly, so there
is no bump and no partial bump. Nothing is on fire — the lane is wrapped in
`|| true` with no `thresholds.break`, so no gate has ever been wrong — but
`AGENTS.md` names `node scripts/run-mutation.mjs <module>` as the strongest
form of test verification, and it currently returns phantom survivors for every
module. Whether to skip the lane or leave it running is the maintainer's call;
#5101 lays out the options. The Rust lane is unaffected.

## Two declines that stay declined

`compareProperty`'s numeric arm is not dead code — `propertyValueColumn`
returns `{col: 'value_num'}` for `Num` and `propertyCompareMatches` passes both
operands through without a type filter, so deleting it would make `10 < 9` true
lexically. It is unpinned, which is a coverage gap and a different thing. The
fixture seed rationales are not narrative either: each records what
`toLowerCase` or a code-unit compare would have produced, which is what stops a
future reader "simplifying" the seed and destroying the pin.

## Verified

`npm run typecheck` clean. `npx vitest run src/lib/tauri-mock/__tests__/
src/editor/__tests__/` — 2983 passed. `npx vitest run conformance` — 12 files,
325 passed. The `spaces_lifecycle.json` edit was applied as a single string
replacement after a structural diff showed `/ops[4]/comment` as the only
semantic change: a parse-and-redump had expanded every short array in the file,
including inside backend-authored `expected` blocks, and `oxfmt` did not put
them back.
