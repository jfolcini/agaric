# Session 1475 — a second marker, not a replacement

Slices 1, 2 and 4 of #4552. `listStyle` had a complete read pipeline — a hook, a renderer, a seeded
property definition, a migration — and **zero production writers**. The only references to
`setListStyle` and `clearListStyle` were in their own test file.

## Slice 1 was a data-loss bug hiding behind a plausible name

`stripBlockMarker` chained five `.replace()` calls, each running on the *previous call's output*. So
once a real marker was stripped, a later pattern in the chain could match again against the block's
own leftover text and strip a second, purely coincidental "marker":

```
stripBlockMarker('# 1. groceries')            → 'groceries'          (want '1. groceries')
convertBlockContent('# - to buy', 'paragraph') → 'to buy'            (want '- to buy')
```

The fix tests each pattern against the *original* line and strips at most one, in `detectBlockType`'s
priority order. The issue said this should ship first and it was right — it is independent of
everything else here and it silently ate user text.

## Slice 2: two list models, and the one the UI reaches was the wrong one

Lists users could actually create were ProseMirror `BulletList`/`OrderedList` nodes *inside a single
block*, with list-ness baked into `blocks.content` as a markdown prefix. The `listStyle` property —
the block-level model, with the marker as data — was unreachable except by typing `listStyle:: bullet`
by hand.

The slash commands, the toolbar and Turn-into now write the property. Turn-into's active-state probe
reads `listStyle` (OR'd with the legacy `editor.isActive` check, since existing content still holds
in-block lists).

The input rule is where the interesting decision was. The brief said "disable TipTap's stock input
rules"; the agent found empirically that doing so breaks `- [ ] ` checkbox creation, and instead kept
them and added an *unwrap* companion — the same shape as the existing `CheckboxInputRule` unwrap
(#1494) — that collapses the transient single-item list into a styled paragraph on the next typed
character. The bullet variant excludes a leading `[` so a checkbox in progress is left for
`CheckboxInputRule` to claim. Falsified by removing that exclusion: the two checkbox regression tests
go red for exactly that reason.

## Slice 4 could not be deferred, and that changed the shape of the work

Slice 2 alone is a **regression**. Once Turn-into writes the property instead of a `1. ` prefix, a
styled block exports as a bare `listStyle:: ordered` line with no marker at all — worse than before
the branch existed, because at least the prefix used to survive as markdown. So the round-trip was not
an enhancement to add later; it was the thing keeping the branch honest.

The export format decides the design, and it is worth stating plainly because it looks wrong at first
glance. The page exporter already prefixes **every** block with `- ` as the outline structure marker.
So a `listStyle` marker cannot replace it — it has to be a *second* marker:

```
- - Buy milk
- 1. Step one
- 2. Step two
- Just prose
```

That is forced, not chosen. A bullet block whose `- ` served as both would be byte-identical on the
wire to a plain block, and the two would be indistinguishable on re-import.

And it is exactly what makes the escaping mandatory rather than a nicety. A `none` block whose text
legitimately begins with `- ` must export as `- \- not a list`, or it re-imports as a bullet. The
escape is injective — `needs_list_marker_escape` looks *past* a leading run of backslashes, so
`- foo → \- foo` and `\- foo → \\- foo` never collapse — and that identity is pinned over twelve
shapes rather than asserted.

Ordinals are never stored. The literal number is discarded on import and re-derived positionally on
export, so `1./2./3.` is a fixpoint and `3./7./1.` normalises on the first pass. A non-`ordered`
sibling restarts the run, matching `computeListOrdinals` in the TS renderer.

## The exclusion list is an asymmetry, and the comment says why

`listStyle` goes into the two **export** copies of the `key NOT IN (…)` set and deliberately *not*
into the two import/parse copies. The four copies are not one set with four spellings; they answer
two different questions:

- *May this key be written as a `key:: value` line?* — No. The marker already carries it, and emitting
  both renders the list-ness twice on re-import.
- *Must this key be refused when it appears in a file?* — No, it must be **accepted**. `listStyle` is
  an ordinary user-settable `select` property; typing `listStyle:: bullet` has to keep working.

The `DRIFT WARNING` above those queries says nothing checks the four copies against each other, so an
asymmetry that is *not* explained reads as an oversight to the next person. The comment states the
two questions explicitly, and a test pins `listStyle`'s absence from `INLINE_PROPERTY_RESERVED_KEYS`
so an "add it everywhere for consistency" edit fails loudly instead of silently regressing import.

## Not done

The TS **paste** parser still does not map a pasted `bulletList`/`orderedList` into one styled block
per item — so pasting `- - foo` into the editor creates a block whose content is `- foo` with no
property. The file import/export path is correct; in-app paste is unwired. Criterion 9's TS half
(`parse(serialize(parse(md))) === parse(md)` with `listStyle` in the arbitrary) belongs with it. The
Rust `export → import → export` fixpoint half is done and asserts exact string equality of the whole
document at both passes, plus the database state — so it cannot pass by export and import being
equally wrong.

Slices 3, 5, 6, 7 and 8 — keyboard grain, legacy content migration, retiring the TipTap list nodes,
the a11y ordinal, the single-step picker — are untouched.
