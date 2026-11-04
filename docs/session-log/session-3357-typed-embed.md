# Session 3357 — Typing a whole embed makes the embed (#6033 S5a)

Set out to build #6033 S5a: typing `![[Name]]` with the closing `]]` (no picker) saved `\![[ULID]]`, a literal `!` before a link, though picking from the `![[` popup made `{{embed [[ULID]]}}` (#6044).

**What shipped.** The closing-`]]` input rule in `block-link-picker.ts` takes an optional leading `!`; when the embed would be its block's whole content it writes the page embed, otherwise the `!` stays text before the link. The picker command and the rule share one predicate, `embedsAt`: a plain paragraph (no `todoState`) that is the only child of block mode's doc or of a page-mode page block, the `!` at its start and nothing after the caret. A `|label` is dropped for an embed, an anchored body (`![[Page#Heading]]`) embeds the page until S10, and an unknown name creates the page first. `picker-plugin.ts`'s `tokenFor` returns `Content`, since an embed is an array.

**Fix found in review.** The first predicate checked only the paragraph offset, so in a heading, quote, task, list item or second paragraph both typing and the picker (already on main) wrote an embed token that renders as literal braces around a chip. Those places now keep `!` plus a link, typed and picked, in both editors.

**Tests.** `embed-trigger.test.ts` (alone, create, label, anchor, the five not-alone shapes × typed/picked × block/page mode, two pages sharing a name) and `e2e/embed-typing.spec.ts` (block and page mode, re-queried after navigating away and back); every predicate arm was falsified alone. Gates: full vitest in shards, typecheck, lint, manual-stage hooks and the 198 Playwright specs `e2e-related` selected (1153 passed) before the review fix; after it, the editor vitest suite and the embed spec.
