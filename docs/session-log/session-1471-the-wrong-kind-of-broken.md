# Session 1471 — the wrong kind of broken

Shipped item 1 of #4551: `((ULID))` block references now resolve on load, and a broken one says it is
a broken *block reference* rather than a broken page link. The rest of that issue — the `kind`
discriminator column, the peek surface, per-block backlinks — is untouched and still open.

## Two bugs, and only one of them was the one in the title

The filed bug is a scan gap. `use-block-link-resolve.ts` and `useBacklinkResolution.ts` both walked
the content looking for `[[ULID]]` and `#[ULID]` and nothing else, so a page whose references were
all `((ULID))` mounted with an empty resolve store and stayed empty: nothing ever asked the backend
for those titles. Both now use one pass over

```
/(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))/g
```

which is the backend's own `ULID_LINK_RE` (`src-tauri/agaric-store/src/cache/mod.rs:68`) plus the `g`
flag `matchAll` needs. One regex, not two, so the two sides cannot drift into disagreeing about what
counts as a link.

The second bug was found while fixing the first, and it is the more interesting one. The obvious
place for a broken block-ref label is `renderBlockRef`'s local `?? '(( … ))'` fallback — but that
fallback only fires when **no resolver is wired at all**. In the app there is always a resolver, and
every one of them (`useBacklinkResolution`, `use-block-resolve.ts`) answers a genuine miss with
`unresolvedBlockLabel(id)`, which is `[[id…]]`-shaped, because `resolveBlockTitle` is the *same*
callback `renderBlockLink` uses for page links. So a broken block reference rendered as a broken
*page* link, and fixing only the local literal would have changed nothing a user could see while
looking exactly like a fix.

## Detecting a miss by value

`resolveBlockTitle` returns a bare string. There is no separate "did not resolve" channel, so the
miss is detected by comparing against `unresolvedBlockLabel(refId)` — the value a resolver produces
when it has nothing.

That is a sentinel comparison, and sentinel comparisons collide. A block whose real title is exactly
`[[<its own first 8 characters>...]]` renders with the `(( … ))` shape too. Reaching it requires a
title matching the truncation of the very id being resolved, and the cost if someone manages it is a
cosmetically wrong chip label, not a wrong target — so this is recorded in the code rather than
designed around. The structural fix is for resolvers to return `undefined` on a miss instead of a
formatted string, which touches every caller of `resolveBlockTitle` and is deliberately not in this
diff.

Worth being explicit that this was written down *before* review rather than after: the recent pattern
in this repo has been comments that claim more than the code delivers, and the cheapest way not to
add another is to state the limitation at the point where someone would otherwise have to rediscover
it.

## What the falsification separated

Three fixes, each broken alone against a copied backup, each restore proven with `cmp`:

- Reverting the `blockRef.tsx` shape-swap to the old `?? unresolvedBlockRefLabel` — RED with
  `expected '[[01ABCDEF...]]' to be '(( 01ABCDEF... ))'`. This is the one that proves the local
  fallback was not the bug: the old code still *has* a `(( … ))` literal, and the test still fails,
  because that literal is unreachable when a resolver exists.
- Reverting `use-block-link-resolve.ts` to `[[ULID]]`-only — RED twice, once on
  `collectUncachedLinkIds` dropping the `((…))` id, once on the cold-mount test never calling
  `batchResolve`.
- Reverting `useBacklinkResolution.ts` the same way — RED on `batchResolve` never being called.

The empty-store precondition is what makes the cold-mount tests mean anything. Pre-populating the
store makes them pass with or without the scan widening, which is the vacuous version of exactly
this test.

## Not done here

`docs/features/tags-and-links.md:32-33` still claims block references transclude. That is false, and
it is being corrected in the #4550 embeds work, which rewrites the same bullet into a full Embeds
section — so this diff leaves the file alone rather than editing a line another branch is replacing.
#4551 says its doc fix "must not land alone"; it does not land alone, it lands next door.
