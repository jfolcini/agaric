# Session 1374 — Giving the resolve-store block title an owner (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer, one fix pass, one review-response pass (no self-review) |
| **Items closed** | `#4228` |
| **Items modified** | — |
| **Tests added** | +32 (frontend) |
| **Files touched** | see the PR's file list |

**Summary:** #4222 fixed the `((` picker *row* for whitespace-only and newline-leading block
content, but the seam underneath it was untouched: nothing owned what the resolve-store
block title actually **is**. Three writers seeded three different values for the same block
id (one full content, two `slice(0, 60)`), `batchSet` diffs on value so whichever ran last
won and the store version churned, and the two renderers each re-derived their own first
line and cap — inconsistently, one of them contradicting its own docblock.

`src/lib/block-title.ts` now owns it: `normalizeBlockRefTitle` — first line, placeholder
substituted, capped at 60 as 57 + `...` — applied **at the seed**. Both renderers render
the stored value verbatim. Doing it at the renderer instead would have left the churn
completely unfixed, which is why the issue specified the seed.

**Three things review found that the builder's own account missed**

1. **`slice(0, 57)` cuts UTF-16 code units.** 56 ASCII characters followed by an emoji
   keeps only the **high surrogate** — invalid Unicode that renders as a replacement box.
   Before this change that existed only transiently inside `renderBlockRef`; the whole
   point of this change is that the title is now **persisted**, so the broken string is
   stored and re-read by every consumer, including the `aria-label` a screen reader
   announces. Fixed with a narrow `sliceWithoutOrphanSurrogate` that repairs only *invalid*
   strings — deliberately not grapheme segmentation, which would change the cap's unit from
   code units to graphemes and with it the length of every stored title. Accepted and
   documented: a cut through a combining mark or ZWJ sequence still degrades the glyph, but
   produces valid text.

2. **There was a fourth writer — and the first argument for touching it was wrong.**
   `useBacklinkResolution`'s `storeTitle` wrote `r.title` verbatim, and the backend does not
   truncate it — `batch_resolve` selects `b.content AS title` raw (its "(truncated)" doc
   comment is stale; filed as **#4237**). The first pass routed the whole branch through
   `normalizeBlockRefTitle`, reasoning "removing `renderBlockRef`'s cap makes an
   unbounded backlink-seeded id a regression I introduced." **That reasoning does not
   hold**: `collectContentIds` matches only `[[ULID]]` and `#[ULID]`, never `((ULID))`, so
   this hook never seeds a block-ref chip *by that route*.

   Review then produced the argument that does hold, and it is a different one. The resolve
   store keys on `${spaceId}::${ulid}` with **no mark class in the key**, so one content
   block reached by `[[id]]` here and by `((id))` through `fetchAndCacheLinks` is **one
   cache entry** — a raw write here is read by `renderBlockRef` regardless of which token
   put it there. The bound is warranted; the *route* is the key space, not this hook's own
   tokens.

   That distinction changes the fix. `batch_resolve` returns `b.content` for **every** block
   type, so an unconditional cap also hit `page` and `tag` rows, where it was pure damage:
   `renderBlockLink` splits the stored title on `/`, so a capped 62-char path yields a
   mangled leaf — or, if the cut lands before the last `/`, a **namespace segment** shown as
   the page name — and the `title=` attribute that exists to keep the full path available
   carried a truncated one. It also re-opened the very divergence this PR closes:
   `useResolveStore.preload` writes `p.content` / `t.name` raw under that same key, so the
   two writers disagreed on every >60-char title and `batchSet`'s value-diff flipped the
   entry (and bumped `version`) on every pass. So `storeTitle` now gates on `r.block_type` —
   normalise `content`, store `page` / `tag` **verbatim**. The blank-row branch is untouched:
   the deliberate `#id…` / `[[id…]]` fallbacks keep `has()` true so a name-less row is not
   re-fetched every pass, and `resolveBlockDisplay` pattern-matches that exact shape to
   detect a cache miss.

3. **The consumer count was 5; it is 14.** The builder's conclusion (none needs untruncated
   content) held, but was reached from an incomplete list. Two of the missing ones were
   themselves store writers' readers.

**A test-file repair, verified rather than trusted.** The builder used `Write` on an
existing test file, destroyed two describe blocks, noticed via a system reminder, and
repaired by hand. Review diffed the repaired region against the merge-base: **zero
differences** — original names, bodies, assertions, comments and whitespace all intact.
Worth the check; a hand-repair that silently drops a test looks exactly like coverage.

**Four pre-existing tests were changed rather than added**, which is how a regression gets
ratified, so each was checked individually. All four pinned renderer-side truncation or a
full-content seed — i.e. precisely the behaviour this issue relocates. One is a genuine
correctness improvement: `[[id…]]` means *unresolved*, so a resolved-but-blank target
reading "Untitled" is more accurate, and the genuinely-unresolved arm still writes
`[[id…]]`.

**The tooltip is gone, not narrowed.** It previously showed up to 300 raw characters — but
only when `searchBlockRefs` happened to win the seed race, so it was a race outcome rather
than a feature and nothing could depend on it. Narrowing it to the stored title left it
rendering the chip's own string back at it: a Radix portal plus a hover/focus state machine
per chip, per block, for zero additional information. The job that remains — reveal what
`max-width` clipped — is a native `title=`, exactly how the sibling `renderBlockLink` does
it, so both chip renderers now set one and the `<Tooltip>` wrapper is deleted. (The
NodeView's old B-67 contract, "a `title=` means deleted", was already dead — `resolveStatus`
has been a documented no-op since Phase 4 — so its test flips from *absent* to *present and
status-independent*.)

**The `text-overflow: ellipsis` was inert, and the CSS test could not see it.** That test
reads `index.css` as text — happy-dom does no layout — so it pins the stylesheet's
**spelling**. The declaration was spelled correctly on `.block-ref-chip`, computed to
`ellipsis`, and did nothing: the rule is `inline-flex`, `text-overflow` applies only to a
**block container**, and a flex container's bare text child is an *anonymous* flex item that
no selector can reach and that takes `text-overflow`'s initial `clip`. So the chip
hard-clipped mid-glyph with no `…` while three assertions stayed green. Both renderers now
put the title in a real `.block-ref-chip-label` child (a flex item, hence blockified, plus
the `min-width: 0` a flex item needs before it will shrink below its content width at all),
and the CSS test asserts each half against the rule that actually carries it. The renderers'
own half — *is the title in an addressable child?* — is pinned by DOM tests in both
renderers, which is the part the spelling test structurally cannot check.

Verified in a browser that lays out rather than by re-reading the rule: the two structures
rendered side by side in Chromium at the real `max-width: 20rem`, `overflow: hidden`
declarations. Before: hard clip through the middle of a glyph, right padding swallowed, no
marker (`clientWidth` 334 vs `scrollWidth` 441 — overflowing, unmarked). After: `Distribut…`
inside an intact pill (`labelClientWidth` 320 vs `labelScrollWidth` 427). A standing e2e
check in a laying-out browser is still the right home for the on-screen criterion.

**Verification:** `tsc -b` clean; `vitest run` → 781 files, **17765 passed**, 1 expected
fail. Every acceptance criterion falsified: reverting each production change reddens its
test, including the symmetric arm where the *wrong* fix (normalising unconditionally, so
the fallbacks vanish) is shown to break cache-miss detection. The `block_type` gate is
falsified the same way — reinstating the unconditional cap reddens three tests, the
load-bearing one being a 62-char `Engineering/Platform/Observability/Distributed Tracing
Rollout` page whose chip drops from `Distributed Tracing Rollout` to `Distributed Tracing
Ro...`.

**Residual, recorded not hidden:** the four writers now agree on all **non-blank** content
and deliberately disagree on blank — `fetchAndCacheLinks` writes "Untitled" while
`useBacklinkResolution` writes `[[id…]]`, because that shape is load-bearing for cache-miss
detection. Full four-way parity needs the cache-miss signal moved off the title string,
which is its own design decision.
