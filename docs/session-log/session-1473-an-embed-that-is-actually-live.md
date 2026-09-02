# Session 1473 — an embed that is actually live

Phase 1 of #4550: `{{embed ((ULID))}}` renders the referenced subtree inline, read-only. The
interesting parts were not the renderer.

## The registry, and why reuse was not enough

`registerPageStore` keeps a slot per page whose `store` field is **overwritten** by the
most-recently-mounted provider, while `liveStores` accumulates all of them. So an embed that simply
reused `slot.store` would be live only while it happened to be the last mounter — and stale on the
common re-mount case, which is the case nobody notices because the content is *almost* right.

Liveness therefore needs a fan-out. Each registered store gets one `subscribe`, held in
`slot.mirrorUnsubscribes` keyed by the store itself rather than by index, because `liveStores` is
spliced by `lastIndexOf` and an index-aligned array would detach the wrong subscription. On a write
the mirror copies `{blocks, blocksById, truncatedTotal}` into the other live stores — deliberately
**not** `loading`, which is per-provider.

The risk here was never the embed. `page-blocks.ts` is load-bearing for the journal week view, where
a bug would be silent. It cannot fire there, structurally: the week view mounts one provider per
**day page**, so each slot has one store, and the mirror bails when `liveStores.length < 2`. That
bail is pinned by test rather than argued, along with "one hop, not a bounce" and detach-on-unmount.
`blocksById` is passed through rather than rebuilt, or every memoised row would invalidate on a
mirror.

A seeding optimisation written into `registerPageStore` was removed before shipping: React runs a
child's effect before its provider's registration effect, so it could never have saved the IPC it
was written to save. Unobservable code in a shared registry is not worth its risk. N embeds of one
page therefore cost N `load_page_subtree` calls, which is the phase-1 budget the issue states.

## The bug the round-trip test found

The first picker implementation inserted `{{embed ((ULID))}}` as **text**. That serialises to
`{{embed \((ULID))}}` — `markdown-roundtrip-fidelity` finding 11 escapes literal `((ULID))` text on
purpose. The escaped form matches neither `parseEmbedToken` nor the backend's `ULID_LINK_RE`, so
every embed would have rendered as inert text *and contributed no backlink*, silently, on the first
blur.

This is the failure mode worth naming: it would have looked fine in the editor, produced no error,
and only shown up after a blur round-trip. The picker now inserts a real `block_ref` node between
literal delimiters, and three cases pin the node form as identity-stable and the text form as broken,
so nobody "simplifies" it back.

## Three decisions the issue left open

1. **An embed inside an embed renders**, bounded by `MAX_EMBED_DEPTH = 3`. Stubbing at depth 1 would
   make an embed of a page that merely happens to contain an embed look broken. The bound is
   documented as a *visual* limit with no relationship to `MAX_BLOCK_DEPTH`, and an explicit note not
   to unify them — they answer different questions.
2. **Embeds do not count toward the host's `truncatedTotal`.** They are not that page's blocks;
   conflating them makes the truncation notice lie. The embed's own overflow is separate
   (`EMBED_MOUNT_LIMIT = 32`, with a row that routes to the source).
3. **Embedded content is in-page-findable, for free** — `InPageFind` is a DOM TreeWalker, so
   embedded rows match and scroll without any work. Embedded rows are tagged `data-embed-block-id`
   rather than `data-block-id` so they never collide with host-tree row selectors.

## The visible cost, stated rather than buried

Embedded rows render **content only**: no todo checkbox, no priority or date chips, no list markers,
no properties, no attachments. Read-only text was the phase-1 line, and this is what that line costs
a user looking at one. Edit-in-place, arrow-key descent, collapse inside an embed and DnD across the
boundary are all Phase 2 by the issue's own scoping.

`docs/features/tags-and-links.md` loses its false "renders the target block's content inline, kept
live" claim about block references — the thing that was never true is now true one construct over,
and the doc says which is which.

## Two guards, neither of them a formality

**The import cycle was real and the obvious fix was wrong.** `EmbedContainer` renders
`EmbeddedBlockTree`, and an embedded row that is itself an embed renders another container — so both
files imported each other. Merging them into one module would have made the guard green while
keeping the coupling, so instead the recursion point is injected: `EmbedContainer` publishes a
renderer into `EmbedRendererContext` and `EmbeddedBlockTree` consumes it.

`EmbedRenderProps` moved into that new module rather than being imported back from `EmbedContainer`.
A type-only import would re-create the edge in any tool that does not special-case `import type`, so
the cycle is now unspellable rather than merely absent.

One correction surfaced mid-fix and is worth keeping: publishing the *component type* through
context and rendering `<NestedEmbed …/>` trips `react(static-components)`, correctly — the compiler
cannot see that the identity is stable, and if it ever changed, every child's state would reset. The
context therefore carries a render **function**, and the element is constructed in the owning module
against its own module-level binding. Calling the component as a plain function instead would have
put `EmbedContainer`'s hooks in `EmbeddedRow`'s hook slot behind a conditional, which is a worse bug
than the one being fixed.

**The `JSON.parse(...) as <Type>` ratchet caught a design mistake, not a missing annotation.**
`embedCollapse` started as a boolean per embed, keyed `embed_collapsed:embed:<hostBlockId>`. Rather
than bump the baseline — permanent, ownerless debt — the preference was reshaped into a `string[]` of
collapsed host block ids scoped to the host page, parsed by the repo's existing validated
`parseStringArray`.

That is better for two reasons that have nothing to do with the guard. A boolean-per-embed key leaks
one `localStorage` entry per embedded block forever with nothing able to sweep it; a per-page id list
is prunable against the ids the page still holds, and matches `blockCollapse`'s existing shape. And
with a boolean defaulting to `false`, "clamp" and "reject" are indistinguishable, so no honest RED
existed — the validator could not be shown to do anything.

With a list it can. The sharpest case is a bare string: `"HOST1".includes("HOST1")` is `true`, so a
wrong-shaped stored value **silently collapses the embed** with no crash to notice it by. That is the
ratchet's whole thesis in one line — a well-formed value of the wrong shape waved through unchecked.

Stated so the count does not flatter the work: of the six rejection cases, the `'{not json'` one
passes with or without the validator, because `readPreference` already catches a decode throw. It is
cheap coverage, not evidence. A paired test that collapse still works from a well-formed entry exists
so the six rejections cannot pass for the trivial reason that collapse never works at all.
