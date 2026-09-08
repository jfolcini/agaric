# Session 1619 — unlinked references printed raw ULIDs

Reported against the running app, on the `ITIS` page: the unlinked-references
panel showed 26-character ids where linked page titles belong. The vault has
the exact case — a block reading `Spoke with [[01KP6NZN93WXY5XX7AXWZTEQVX]],
he is missing from some aliases (created itis case), added him to the rocket
channels.` That ULID is the page `Patricio Aumedes`, and the panel printed the
id.

## Root cause

The row rendered `{block.content}` — the raw markdown string. Every other
surface that shows block content parses it and renders `[[ULID]]`,
`((ULID))` and `#[ULID]` tokens as resolved chips. The linked-references panel
sitting directly above this one has always done so, through
`useBacklinkResolution` plus `renderRichContent`, which is why the same token
resolved on one panel and not the other.

A comment in the file claimed the matched-block content path "already benefits
from `useBacklinkResolution` warming". It did not: the hook was never called
here, and the only warming this component did was for the source-page group
headers. The comment is corrected rather than deleted, since the header
pre-warm it introduces is still needed and still separate.

## What shipped

`useBacklinkResolution(groups)` and a `renderRichContent` call on the row.

Two options are deliberately not passed. `inline: true`, because the row is a
single-line truncating button and block-level output (headings, lists, tables)
does not belong inside one. And no `interactive` / `onNavigate`, because a
chip with `role="link"` nested inside that button would be invalid and would
compete with the row's own click. The chips render inert; the row still
navigates.

## Verification

One new test in `UnlinkedReferences.test.tsx` feeds a group whose block carries
a `[[ULID]]`, stubs `batchResolve` to return the title, and asserts the chip
reads `Patricio Aumedes` while the raw id appears nowhere in the row.
Falsified against a backup: restoring the old `{block.content}` render fails it
on the missing chip, and the file compares clean afterwards.

That file now passes 52 tests, the backlinks directory 141, and the wider run
with `PageEditor` and the resolution hook 205. `npm run typecheck` is clean.

The file's `lucide-react` mock is deleted. Pulling the rich renderer in made it
fail on an icon it did not list, and it was a whitelist whose four test ids no
assertion ever used. `LinkedReferences.test.tsx`, which renders the same
content, never mocked the icons at all.

No `e2e-tauri/` spec. That lane exists because the JS mock is a second
implementation of the Rust backend; this defect is in how the frontend renders
a string it already had, and the new test drives the real renderer.
