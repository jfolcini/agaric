# Session 1685 — a reference you can look into

#4551, third of three PRs. A `((ULID))` chip showed sixty characters of its
target and nothing else; #4228 had removed the old tooltip because it
rendered the chip's own string back at it and cost a portal per chip. The
peek answers both objections the way the issue asked: it shows what the
chip cannot (the full content, where the block lives, how many references
it has, actions), and it is one delegated host per page container, so a
page with five hundred chips has the DOM it had plus at most one popover.

`useBlockRefPeek` listens on the container in the capture phase, so the
inner label span still fires, and opens after a 350 ms dwell (longer than
the link preview's, because a pointer crossing a paragraph of chips must
open nothing) or on `Alt+ArrowDown` from a focused chip, the ARIA binding
for an element carrying `aria-haspopup`. While open it parks the chip's
`title` so the native tooltip cannot race it, flips `aria-expanded` where
the render put one, and survives the pointer travelling into the peek.
Escape closes; it consumes the key and returns focus to the chip only when
focus is inside the chip or the peek, because a hover peek can be open
while the user types and Escape is the editor's blur gesture. Touch keeps
the `title` for now; long-press collides with the block tree's own and is
dropped from this version.

The payload goes through `batchResolve` first, which is the space and
liveness gate: a foreign-space target never reaches `getBlock`, a deleted one
shows a tombstone. Then `getBlock` for the content, `getBlock` again for
the page title (a one-hop breadcrumb; there is no ancestor-path command),
and `countBacklinksBatch` for the reference count, which is target-agnostic
in SQL and whose `PageId` deserialises without a page-ness check. A TanStack
query keyed on space and target, never the resolve store. An IPC failure
renders its own line rather than the foreign-space one, which had told a
user with a flaky backend to go looking in other spaces.

Chips advertise themselves to the host with `data-type` and `data-id` only
when they own their navigation. The builder had gated on `interactive`,
which put a peek on backlink and agenda rows whose Open then bubbled to the
row and navigated to the citing block instead of the target. Narrowing the
gate fixes the wrong destination and means those read rows have no peek;
giving them one is a click-behaviour change for the maintainer to decide,
noted in the PR. Two things dropped from the plan and flagged: a Zoom
action (there is no inward zoom path; PR B only lifted zoom outward) and
the children preview (#4550's embeds own that). The deleted chip's
accessible name now contains its visible label, with the suffix in a
visually hidden span.

## Verified

- vitest over the peek, its hook, the renderer marks, `PageEditor`,
  `DaySection`, the backlinks and `StaticBlock`: 21 files, 657 passed.
- `npm run typecheck` exit 0; the IPC error-path guard now counts 62
  components; raw-invoke and oxlint clean.
- Playwright `e2e/block-ref-peek.spec.ts`, plus `in-page-find` and
  `block-linked-references` for the surfaces it touches: 7 passed.
- Falsified on copies, restored `cmp`-clean: rendering the title instead of
  the content; a shorter dwell; Escape not restoring focus; the wrong key;
  `title` not parked; the warn dropped; the closed-state early return
  removed (five tests red, including the one-peek-on-fifty-chips guard);
  the `aria-label` override restored; immediate close on leave; the touch
  guard removed; the deleted early return removed; the breadcrumb source
  nulled; Open not clicking the chip; the host given no container (e2e
  red); and from the reviewer, hover calling `.focus()` (green before its
  test existed, red now), the `relatedTarget` guard removed, the
  unconditional Escape, and the wider gate.
- Not run locally: the full suites (CI carries them; the laptop is in use).
