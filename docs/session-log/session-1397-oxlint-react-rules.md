# Session 1397 — a linter upgrade that had to land atomically, and the invariant it exposed

Phase 1 of #4377. The oxlint bump in Dependabot PR #4373 enables React Compiler rules this
codebase had never been checked against: **296 errors across 139 files**, over prek's four
sharded invocations.

## The plan in the issue was wrong, and checking it is what found that

#4377 proposed: land a `.oxlintrc.json` change on `main` setting the new rules to `warn`,
then let Dependabot's rebase pick it up. That is the standard shape, and here it would have
**red-lit `main`**.

oxlint does not tolerate an unknown rule name by ignoring it — it **rejects the entire config
file**:

```
$ oxlint -c <probe>.json           # installed 1.77
Failed to parse oxlint configuration file.
  x Rule 'refs' not found in plugin 'react'
```

Confirmed against 1.78.0 as well, the version `package-lock.json` pinned on `main`. So the
config change and the version bump are **atomically coupled** and must land in one commit.
Landing the config first would have replaced a red Dependabot PR with a red trunk.

The rules also live under the **`react`** plugin, not `react-hooks`, and they ship in the
`correctness` category — which is why first contact makes every one an `error` rather than a
warning.

Names were derived by running oxlint 1.79.0 with `-f json` against the tree, not guessed: the
CI log's `github` formatter omits rule codes. The reconstruction reproduces the issue's
numbers exactly (168 + 89 + … = 296).

## The rationale had to go inside the file, which cost a hook exclude

The eight `warn` entries need to say *why*, or they read as unexplained suppressions — the
exact thing #4368's filing-bar work exists to prevent. oxlint sets `additionalProperties:
false`, so a `$comment` sibling is rejected, and there is no per-rule metadata slot. The only
place is a JSONC comment.

oxlint documents comment support; prek's `check-json` does not. `.oxlintrc.json` is now
excluded from that hook — narrowly and anchored — with the reasoning inline. `tsconfig.*.json`
was already excluded for the same reason, so this follows existing precedent rather than
setting one. Validation is not lost, only relocated: oxlint itself rejects the file on a bad
rule name, which is a stronger check than `check-json` was performing.

The exclude was proven load-bearing by reverting it (`check json ... Failed: key must be a
string at line 100 column 5`) and restoring it.

## `use-block-zoom.ts:193` — safe pattern, real invariant, unpinned until now

A reviewer flagged this on #4370 before the bump existed: `rebaseCacheRef.current` is written
during render inside `useMemo`.

**The ref access is safe**, for two reasons that are properties rather than luck. The read is
revalidated — an entry is consumed only when `cached.src === block && cached.depthOffset ===
depthOffset`, both re-derived from this run's inputs, so a hit is value-identical to what the
miss branch would compute. And the write is idempotent, so StrictMode's second invoke hits
every entry the first wrote.

Rewriting it would be **strictly worse**. `BlockListRenderer.tsx` moved its analogous write
into `useLayoutEffect` under #4012 — correct there, because that cache spans commits. Here the
cache is built *and consumed within the same memo run*, so a commit-time write would leave it
empty exactly when it is read, silently deleting #3253.

**But the reviewer's second concern was right, and sharper than stated.** With the cache, a
`FlatBlock` mutated in place inside a new `blocks` array is a cache *hit*, so the pane
re-emits a row built from the old fields — a stale zoomed pane beside a correct unzoomed tree.
Without the cache the same scenario re-clones and picks the change up. The cache genuinely
widens the blast radius.

Nothing guarded that. `FlatBlock` is not `readonly`, there is no immutability rule, and most
of the store's "identity preserved" tests assert only `expect(after).toBe(before)` — **which
an in-place write satisfies**. That is a half-covered pair already in the repo. The `delta ≠ 0`
arm of `moveToParent` — the reducer that rewrites `depth`, precisely the field the pane
rebases on — had no coverage of it at all.

So the fix went where a violation can actually occur: a test pinning both arms of that
reducer, plus a comment naming the dependency, citing the test, and forbidding the two
"optimisations" that would break it (weakening the hit condition to an id compare; moving the
write to an effect). Both arms redden independently under mutation.

## The bucketing rules — the actual deliverable

296 findings cannot be triaged one at a time. Two predicates sort them:

**`react/refs` (168) — the StrictMode idempotence test.** Benign iff running the render body
twice on identical inputs returns an identical value *and* leaves the ref in an identical
state, and every ref read that reaches the output is revalidated against a key derived from
this render's own inputs.

The consequence is the headline: **~81 findings across 45 sites are a single idiom** — the
latest-value mirror (`xRef.current = someProp` at hook top level, read only from effects,
handlers, or plugin closures). A shared `useLatestRef<T>` helper carrying one justified
disable collapses all of them. That is a pure refactor and the highest-leverage move in the
burn-down. `use-roving-editor.ts` (26 findings) is this and nothing else. Zero instances of
the genuinely dangerous shapes (`ref.current++` during render, un-revalidated reads reaching
output) exist in the tree.

**`react/set-state-in-effect` (89) — the deletion test.** Real iff the state could be deleted
and every read replaced with the expression the effect computes. Not deletable — needs the
committed DOM, an external subscription, or an async result — means benign; so is a bail-out
guarded `setX(prev => cond ? prev : next)`.

43 are async-fetch prologues (benign by design; the cost is one pass per *fetch*, not per
render). ~20 are real, and almost all are one shape: resetting a draft when an identity prop
changes, fixed with a `key` or a render-phase adjustment. **None is on the block-tree or
agenda hot path** — they are dialogs and popovers that open once. That answers the issue's
open question directly. Cost is per *trigger*, not per render, so the real ones sort by
trigger frequency rather than by file.

Three other rules close out cheaply: all 10 `react/globals` are render-counters in test files;
all 7 `react/incompatible-library` are one library (TanStack Virtual); 5 of the 15
`react/immutability` are a different sub-rule about self-referential `useCallback` recursion
and deserve a real look, since that one can capture a stale closure.

## Fixed with zero suppression

All four `eslint/no-irregular-whitespace` findings, and the rule stays `error`. Three were a
zero-width space wedged inside `*​/` so a JSDoc could display a block-comment terminator
without closing itself — load-bearing, and structurally un-suppressible, since a disable
directive cannot go inside a block comment. Rewritten as `*\/`, same display, no invisible
character. The fourth was a raw U+00A0 in a comment quoting `allowedPrefixes`, where the
production source writes `' '` — so the comment did not match the code it cited.

## Notes for whoever lands this

`npm ci` is required before the hooks run: the shared `node_modules` still held 1.77.0, and
the new config is unparseable to it. This worktree was given its **own** `node_modules` rather
than upgrading the shared tree, because five other worktrees symlink it and the old config
plus a new oxlint would have turned these rules into errors everywhere at once.

PR #4373 is now partly superseded — it also carries oxfmt 0.63 → 0.64, deliberately left
alone here because reformatting the tree is a separate blast radius. Dependabot's rebase
should reduce it to the oxfmt half.

Verified: oxlint 1.79.0 exit 0 (0 errors, 318 warnings), **and 1.80.0 exit 0 with an identical
rule set**, so the next bump is already known safe. `tsc -b` clean; 76/76 across the three
touched test files.
