# Session 1662 — invariant 10's frontend half had one enforcement, and it is being deleted

#4918 asked what replaces it. The answer turned out to be decidable, because
the defect was already in the tree.

## What the measurement showed

`AGENTS.md` invariant 10 says a frontend call site takes the `SafeLimit` brand
so the bounds check runs there rather than round-tripping a bad value to the
backend. Nothing enforced that except the hand-written `@/lib/tauri` wrappers'
signatures — no prek hook, no oxlint rule, no script; `safe-limit.ts`'s own
docstring said as much. #4411 is retiring those wrappers.

Deriving each command's `limit` argument index from `src/lib/bindings.ts` and
scanning every call site: **16 commands take a limit, 37 production call sites
pass one, and exactly one passed a bare number** —
`empty-block-cleanup.ts` handing `getBacklinks` a literal `1`. Harmless at that
value, and precisely the anti-pattern the invariant names. Fixed here with
`paginationLimit(1)`.

That single hit is what makes this a guard rather than speculation:
`AGENTS.md` § "Guards earn their keep" wants the defect to have occurred, and
it had.

## The option that was not taken

Branding the generated `limit` — `SafeLimit = number & { … }` — is the only
answer that restores the property rather than approximating it, because it
would reject an unbounded VARIABLE too, not just a literal.

specta cannot express it. A Rust newtype deriving `specta::Type` emits
`export type SafeLimit = number`, which is an alias, not nominal — a bare
number still assigns. Getting a real brand means post-processing the generated
file, in all three places that produce or compare it (`regenerate_ts_bindings`,
`ts_bindings_up_to_date`, and `just gen-bindings`), and leaves `bindings.ts` no
longer purely generated for a future specta upgrade to collide with.

Weighed against one literal in the tree, that is not the smaller change. The
trade is recorded on #4918 so the next person does not re-derive it.

## The guard

A vitest test, not a prek hook: the hook budget is capped and this needs no
per-commit speed, and `hand-stub-ratchet.test.ts` is the repo's precedent for a
tree-walking check that lives in the suite.

The command→argument-index map is **derived** from the generated bindings, never
hand-written — a second table is the drift this whole area exists to remove. It
fails closed: a bindings file it cannot parse yields an empty map, which would
look exactly like a clean tree, so the map being non-empty is asserted first.

## Round one: the scanner failed open

The first version hand-rolled argument splitting with a quote/bracket state
machine — a fourth copy of `scripts/lib/js-scanner.mjs`, whose header says in
as many words not to write one (#3991), and which #4484 had already removed
from another guard one directory over.

The copy carried the defect the rule was written for. Given
`commands.getBacklinks(blockId.replace(/[,)]/g, ''), null, 20, …)`, the `)`
inside the character class terminated the scan: it returned **two** arguments,
the limit slot read as empty, and a bare `20` went unreported. Checked by
running the old splitter against that input, not by argument.

Now `findMatchingBracket` + `splitTopLevelCommas`, which throw `ScanError` on
undecidable input, so the test reddens instead of skipping.

## Round two: the map was 16 of 17

The command→index map was built with `/^\t(\w+): \(([^)]*)\) =>/` over the raw
bindings. `[^)]*` cannot cross a `)`, and `filteredBlocksQuery`'s parameter
list carries doc-comment parens. That one command — `limit` at index 5, backend
cap 200 — was silently absent, so `commands.filteredBlocksQuery(…, 500)` left
the guard green. The PR's own "16 commands" figure was that off-by-one, quoted
as fact.

The fail-closed check asserted only that the map was non-empty. A
*per-command* parse failure is fail-open, and it was already happening. The
bindings now go through `stripComments` before the match — the same scanner,
already imported — and the map holds 17.

Two rounds, two fail-opens, both in the half of the guard that reads source.
The half that fails closed was the half that got the assertion.

## Round two also found this file empty

An edit to this log opened it for write before reading it —
`open(p, 'w').write(open(p).read()…)` evaluates the truncating open first — and
committed a 0-byte file. `session-log-numbering` checks headings on staged
*additions*; the file was already tracked, so nothing caught it. Recovered from
the commit that had it, and the intended edits re-applied to the recovered text.

## Falsification

Three arms, each against a `cp` backup, each restored `cmp`-identical:

- put the original bare `1` back — red, naming `empty-block-cleanup.ts:138`;
- a literal in a *different* command's limit slot (`listTrash(null, 500, …)`) —
  red, which is what proves the per-command index is real rather than a fixed
  position;
- a literal in a **non-limit** slot — green. Without that arm the guard could
  have been a blunt "no numbers in a `commands.*` call" and nobody would know;
- a bare limit behind a regex literal containing `)` — red (round one's arm);
- a bare limit in `filteredBlocksQuery`'s slot 5 — red (round two's arm).

## What it does not catch

An unbounded variable. Stated in the guard's own docstring and in
`safe-limit.ts`, rather than left for a reader to discover — a guard that looks
like a guarantee it does not provide is worse than none.
