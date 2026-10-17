# Session 2304 — Outline shows titles; Edit as Markdown protects and explains its ULIDs

#5686: on one of the maintainer's pages, both the Outline and Edit as
Markdown showed ULIDs.

**Diagnosis** (posted on #5686).
- **The Outline** printed each heading's stored text, so `[[ULID]]`,
  `#[ULID]`, `((ULID))` and `**` showed raw.
- **Edit as Markdown** writes `[[Title]]` and `#name` wherever the importer
  reads them back to the same id, and keeps ULIDs by design for:
  - block refs and ref-type property values;
  - duplicate titles, cross-space and deleted targets.

The maintainer pointed out that cross-space links and duplicate page titles
are refused today, so those cases can only come from older data or offline
sync. They asked to keep the ULIDs, to show a faint title on hover or at the
cursor, and to protect the tokens from accidental edits.

**1. Outline.** Headings render through `renderRichContent` with
`useRichContentCallbacks()`, inline and non-interactive. The outline mounts
from `PageHeader`, outside BlockTree's resolver provider, hence that hook.
Titles, formatting and the existing fallback labels show as they do on the
page.

**2. Title hint.** A non-editable decoration carries the title, and CSS draws
it under the token on hover or while the focused buffer's cursor touches it.
- It is generated content, so it is never in the text or the clipboard.
- Missing targets show the chip's fallback label, struck through.
- A hidden live region announces "Points to …".
- Ids resolve in one batch per change, through the resolve store.
- The fade uses `--duration-fast`, which reduced motion already zeroes.

It covers the start of the next line while it shows.

**3. Atomic tokens** (`source-buffer-ulids.ts`):
- the arrow keys step over a token;
- Backspace or Delete beside it removes it whole, as one undo step;
- typing inside it is refused, and so is any change that would split one,
  IME compositions included; undo and redo are exempt;
- **overlap rule: clamp.** A paste or replacement that would split a token
  lands beside it, so nothing the selection didn't hold whole is deleted;
- the `[[` and `((` pickers no longer open inside a token, where any pick
  would be refused.

**4. Save check.** `findUnresolvedUlidTokens` (in `src/components/pages`; the
tier-layering hook keeps it out of `src/lib`) finds tokens that point to
nothing. Save warns with a toast listing them, then saves. #5685's Changes
view can call the same function.

**Tests.** Every new vitest test and the Playwright spec went red under a
mutation:
- the outline and the hint against the old code;
- Backspace not handled;
- typing not refused.

A "hint not copied" test that no code change could fail was deleted.

Gates: vitest (34 files, 1,338), `npm run typecheck`, oxlint, oxfmt, prek,
and the new spec with page-source-edit, page-outline and checkbox-typing (75
at `--repeat-each=3 --retries=0`). After that run, the token module moved
from `src/lib` to `src/components/pages`, a path-only change. Typecheck and
vitest passed after the move, and CI runs the spec again.
