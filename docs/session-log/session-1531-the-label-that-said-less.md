# Session 1531 — the label that said less

#4719: query-result rows rendered `[[ULID]]` as a bare ULID, and `DuePanel`'s projected rows were
missing the `inline: true` that keeps a heading or list out of a one-line clamping span.

The rendering half was mechanical. Everything interesting is in the accessible name.

## The brief would have moved the bug into the announcement

The instruction was to keep `resolveBlockDisplay` returning a plain string for the `role="option"`
name and render the display body richly. That is the right split and it would have shipped a
worse bug than the one being fixed: `truncateContent` strips the `[[ ]]` brackets and leaves the
ULID, so the row would have *displayed* "follow up on Quarterly Plan" while *announcing*
"follow up on 01KP36KDG2ABCDEFGHJKMNPQRS" — WCAG 2.5.3, Label in Name.

Fixing the visible text without the name would have made the two disagree, which is the same
defect one layer down. So the plain string had to resolve refs too.

## Three ways the first attempt was still wrong, all measured

**The label was never load-bearing in its own tests.** `getByRole('option', { name: '…' })` passed
with the `aria-label` deleted — the chip resolves to the same words, so the accessible name comes
from the contents either way. The pair only went red on an argument-type error in a different
assertion. An assertion true for two reasons, and the reason it was true had nothing to do with
the attribute. The rewrite asserts the attribute directly and adds a namespaced case
(`Work/Quarterly Plan`), where the chip shows only the leaf and the role-name query can therefore
*only* be satisfied by the label.

**The label said less than before.** Measured with `computeAccessibleName`: the row previously
announced `"TODO call the plumber My Page"`, computed from its contents. Setting
`aria-label={title}` replaced that with `"call the plumber"` — the todo state and the parent page
silently dropped out of what a screen reader says. Adding a label to fix a name is exactly the
move that can shrink one, because `aria-label` overrides contents rather than adding to them. Now
composed from the three visible parts, with the page arm mirroring the render condition.

**The resolver claim held on half the call sites.** The fix argued that the substitution uses the
same resolver the chips render from. True via `StaticQueryBlock`/`EditableBlock` — but
`AdvancedQueryView` and `GroupedResults` render `QueryResultList` with no such prop while their
chips still resolve through `useRichContentCallbacks`. Measured on the diff as submitted:

```
{"visible":"follow up on Quarterly Plan","label":"follow up on 01KP36KDG2ABCDEFGHJKMNPQRS"}
```

The 2.5.3 break the fix is argued from, alive on two of four call sites, in the fix for it.

## The axe test that fired for the wrong reason

The first axe test was green against the plausible wrong fix (`interactive: true`). Probing the
DOM showed why: a `[[…]]` chip carries `tabIndex="0"` but no widget role, so `nested-interactive`
never fires on it. The fixture needed a markdown link, which does get `role="link"`.

The confirmation is the part worth keeping: with `interactive: true` **and** the link removed, the
file goes fully green. So the `[docs](…)` in the fixture is load-bearing, not decoration — and the
only way to know that was to try both mutations rather than one.

## A shipped violation, found by fixture archaeology

The existing axe test in that file passes `parent_id: null, page_id: null`. That is not an
accident of test data: with a parent page the row renders `PageLink` — a
`<span role="link" tabIndex={0}>` — inside the `role="option"`, and axe reports
`nested-interactive`. The fixture had been shaped around a real violation, which is how it stayed
invisible. Filed separately; not this PR's to fix, since it turns on whether the page shortcut
should be a widget at all.
