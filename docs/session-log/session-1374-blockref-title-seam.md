# Session 1374 — Giving the resolve-store block title an owner (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer, one fix pass (no self-review) |
| **Items closed** | `#4228` |
| **Items modified** | — |
| **Tests added** | +26 (frontend) |
| **Files touched** | 13 modified, 5 new — see the PR's file list |

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

2. **There was a fourth writer.** `useBacklinkResolution`'s `storeTitle` wrote `r.title`
   verbatim, and the backend does not truncate it — `batch_resolve_inner` selects
   `b.content AS title` raw (its "(truncated)" doc comment is stale; filed as **#4237**).
   Pre-existing, and contained until now precisely *because* `renderBlockRef` re-derived a
   cap. Removing that cap turned it into a regression, so it is fixed here rather than
   filed: a regression this change introduces is this change's to fix. The resolved-content
   branch now normalises; the branch **condition** is untouched, so the deliberate
   `#id…` / `[[id…]]` fallbacks for blank rows survive — they keep `has()` true so a
   name-less row is not re-fetched every pass, and `resolveBlockDisplay` pattern-matches
   that exact shape to detect a cache miss.

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

**The tooltip narrowed, deliberately.** It previously showed up to 300 raw characters — but
only when `searchBlockRefs` happened to win the seed race, so it was a race outcome rather
than a feature and nothing could depend on it. It still reveals the tail the chip's
`max-width` + ellipsis clips. Restoring full text would put raw multi-line content back in
the store and immediately re-diverge the two renderers.

**On the CSS test.** It reads `index.css` as text, and happy-dom does no layout, so it pins
the stylesheet's **spelling**, not behaviour. Review noted the rule already uses `@apply`,
and Tailwind's `truncate` *is* the nowrap/overflow/ellipsis trio — so the idiomatic tidy-up
would have reddened three assertions for zero behaviour change. It now accepts `@apply
truncate` and a `var()` max-width, and its docblock says plainly what it can and cannot
prove. The real bound belongs in an e2e check in a browser that lays out.

**Verification:** `tsc -b` clean; `vitest run` → 781 files, **17759 passed**, 1 expected
fail. Every acceptance criterion falsified: reverting each production change reddens its
test, including the symmetric arm where the *wrong* fix (normalising unconditionally, so
the fallbacks vanish) is shown to break cache-miss detection.

**Residual, recorded not hidden:** the four writers now agree on all **non-blank** content
and deliberately disagree on blank — `fetchAndCacheLinks` writes "Untitled" while
`useBacklinkResolution` writes `[[id…]]`, because that shape is load-bearing for cache-miss
detection. Full four-way parity needs the cache-miss signal moved off the title string,
which is its own design decision.
