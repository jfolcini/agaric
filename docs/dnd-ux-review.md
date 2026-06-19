# Block Drag-and-Drop & Keyboard-Move — UX / Engineering Review

_Scope: pointer drag-and-drop reordering/nesting and keyboard move/indent in the
block outliner. Reviewed against the real Tauri backend (`src-tauri`), the
frontend DnD pipeline (`src/hooks`, `src/lib`, `src/components`), and the Tauri
web mock (`src/lib/tauri-mock`). All citations below were read and verified at
the cited line numbers._

---

## 1. Executive summary

The drag-and-drop / keyboard-move feature has **four confirmed correctness
bugs**, all rooted in one design flaw: blocks use a **gapless 1-based integer
`position`** per parent, but neither the backend `move_block` nor the frontend
position arithmetic ever **renumbers siblings to make room**. The frontend hands
the backend either a _colliding_ integer (which the DB then disambiguates by
ULID, i.e. creation order, not drop intent) or a _non-positive_ integer (which
the backend rejects outright with an error toast). The result: dragging a block
one slot down no-ops, dragging up between siblings lands in the wrong place,
and dropping at the top / nesting as a first child fails with an error.

Severities: **2 × P0** (silent wrong-place / no-op moves — data the user
believes they reordered, didn't), **2 × P1** (hard failures with an error toast
for the very common "move to top" and "nest as first child" gestures). A
secondary **P1 architectural defect** routes essentially _every_ pointer drag
through a full page reload, and the bugs are **partly hidden** by a more
permissive web mock — a real testing-gap risk.

---

## 2. Correctness bugs

All four are encoded as passing `it.fails(...)` + characterization tests in
`src/lib/__tests__/dnd-pipeline.test.ts` (read in full; the harness faithfully
reproduces `handleDragEnd` + the real backend semantics).

### Root-cause model (verified)

- **Gapless positions on create.** New blocks are inserted at
  `COALESCE(MAX(position), 0) + 1` per parent → consecutive `1, 2, 3, …` with
  **no gaps**. `src-tauri/src/commands/blocks/crud.rs:201-208`.
- **`move_block` never renumbers.** The mutation is a bare
  `UPDATE blocks SET parent_id = ?, position = ?` —
  `src-tauri/src/commands/blocks/move_ops.rs:162-167`. Siblings at or after the
  target position are **not** shifted.
- **Non-positive positions are rejected.** `move_block_inner` fails closed on
  `new_position <= 0` with
  `AppError::Validation("position must be positive (1-based), got …")` —
  `src-tauri/src/commands/blocks/move_ops.rs:43-47`.
- **Ties break by ULID, not drop intent.** The page tree is loaded by
  `load_page_subtree`, ordered `COALESCE(position, ?6) ASC, id ASC`
  (`src-tauri/src/commands/pages/listing.rs`); the per-parent child listing is
  likewise `ORDER BY position ASC, id ASC`
  (`src-tauri/src/pagination/hierarchy.rs:69`, mirrored at
  `src-tauri/src/commands/blocks/queries.rs:540`). So when two siblings share a
  `position`, the DB orders them by their ULID (creation order), **not** by
  where the user dropped.
- **Frontend drop path.** `src/hooks/useBlockDnD.ts` `handleDragEnd` (lines
  138-203) → `src/lib/tree-utils.ts` `getProjection` (146-251) +
  `computePosition` (266-316). Keyboard path:
  `src/hooks/useBlockKeyboardHandlers.ts` →
  `src/stores/page-blocks.ts` (`indent`/`dedent`/`moveUp`/`moveDown`/`reorder`)
  → `midpointPosition` in `src/lib/block-tree-ops.ts:20-23`
  (`Math.floor((a+b)/2)`, bumped to `a+1` on collision — i.e. it returns a
  **colliding** integer for any two adjacent siblings).

---

### BUG 1 — Downward drag onto the adjacent sibling no-ops (P0)

**Symptom.** User drags block A down so it sits just below its next sibling B.
The block snaps back; nothing moves. No error, no toast — it just silently
doesn't work.

**Root cause.** `getProjection` simulates the move and uses
`projectedIndex = overIndex > activeIndex ? overIndex - 1 : overIndex`
(`tree-utils.ts:205`) to account for the active item vacating its slot — but
`handleDragEnd` then computes the position from the **raw** `overIndex`, not the
adjusted one: `computePosition(visibleItems, projected.parentId, overIndex, blockId)`
(`useBlockDnD.ts:161-164`). Because the active block still occupies the slot
_above_ the drop target, `computePosition` scans for the last sibling whose flat
index is `< dropIndex` (`tree-utils.ts:285-291`) and concludes it should insert
_before_ B — returning A's own position. Verified by
`dnd-pipeline.test.ts:159-170` (`position` comes back as `1`, equal to A's own).

**Recommended fix.** Pass the projection-adjusted index (the same
`overIndex > activeIndex ? overIndex - 1 : overIndex` correction) into
`computePosition`, _and_ adopt a renumbering or fractional scheme (§ below) so
"insert after B" produces a value strictly between B and B's successor rather
than a colliding integer.

---

### BUG 2 — Upward drag between two siblings lands in the wrong place (P0)

**Symptom.** User drags block C up to sit between A and B. Expected `[A, C, B]`;
actual order is unchanged (`[A, B, C]`). Silent — looks like the drag was
ignored.

**Root cause.** `computePosition` finds it is inserting after A and before B,
sees no gap (`nextPos - afterPos === 1`), and falls through to
`return afterPos + 1` — i.e. **B's exact position** (`tree-utils.ts:299-315`,
final branch at 314-315 explicitly "rely on backend to handle collisions").
The backend does **not** renumber (`move_ops.rs:162`), so C and B now share a
position and the `position ASC, id ASC` ordering breaks the tie by ULID. Since B
was created before C (`B < C`), B sorts first → C ends up _after_ B, unchanged.
Verified by `dnd-pipeline.test.ts:176-187`.

The same defect affects the keyboard path: `midpointPosition` returns `a+1`
for adjacent siblings (`block-tree-ops.ts:20-23`), and the store's `reorder`
relies on it (`page-blocks.ts:127-148`, `486-492`).

**Recommended fix.** As BUG 1 — renumber or fractional ordering so the inserted
block gets a key strictly between its two new neighbors. The trailing comment
in `computePosition` ("rely on backend to handle collisions") is a false
premise: the backend does not.

---

### BUG 3 — Drop / move to the TOP is rejected (P1)

**Symptom.** User drags a block above the first sibling (or presses
`Ctrl+Shift+↑` on a block whose previous sibling is at position 1). They get an
**error toast** (`error.moveBlockFailed` / `error.moveBlockUpFailed`) and the
block does not move.

**Root cause.** Inserting before all siblings computes `firstPos - 1`
(`tree-utils.ts:293-296`). With the first sibling at the gapless position `1`
that is `0`, which `move_block_inner` rejects (`move_ops.rs:43-47`). Verified by
`dnd-pipeline.test.ts:193-202`.

This is not drag-only — it manifests across every "move to front" path that
subtracts 1 from a position-1 sibling:

- **`reorder` to index 0:** `computeReorderPosition` returns
  `firstSiblingPos - 1` (`page-blocks.ts:142-144`).
- **`moveUp` when prev sibling is at position 1:**
  `newPosition = (prevSibling.position ?? 0) - 1` → `0`
  (`page-blocks.ts:623-624`).
- **`dedent`:** `newPosition = (parent.position ?? 0) + 1`
  (`page-blocks.ts:571-572`) — not a `<= 0` failure, but it **collides** with
  the parent's next sibling (same class as BUG 2), so a dedented block can land
  in the wrong order relative to the parent's siblings.

**Recommended fix.** Never emit `position <= 0`. Either renumber the target
sibling group (shift everyone ≥ the insertion point up by 1, then insert at the
freed slot), or move to a fractional key where "before the first sibling" is
`firstKey / 2` (still > 0) — see § below.

---

### BUG 4 — Nesting as the FIRST child of a populated parent is rejected (P1)

**Symptom.** User drags a block so it becomes the first child of a parent that
already has children. Error toast; the block does not nest.

**Root cause.** Same arithmetic as BUG 3: dropping before the parent's existing
first child computes `firstPos - 1 = 0`, rejected by `move_ops.rs:43-47`.
Verified by `dnd-pipeline.test.ts:223-241`. (Note: nesting as the first child of
an _empty_ parent works, because `computePosition` short-circuits to `return 1`
when `siblings.length === 0` — `tree-utils.ts:281`. It is specifically
_populated_ parents that fail.)

**Recommended fix.** Identical to BUG 3.

---

### Fixing the position scheme — options & tradeoffs

The four bugs share one cure. In rough order of robustness:

**(a) Backend "make room" renumber (recommended).** On `move_block`, in the same
`BEGIN IMMEDIATE` transaction, shift siblings to open a slot:
`UPDATE blocks SET position = position + 1 WHERE parent_id IS ? AND position >= ? AND deleted_at IS NULL`,
then insert the moved block at the requested 1-based position.

- _Pros:_ keeps the simple integer scheme; fixes all four bugs at the source;
  the frontend can stop emitting `firstPos - 1` and `afterPos + 1` collisions
  and instead pass a clean 1-based target index.
- _Cons / op-log + sync impact:_ a single move now mutates **N sibling rows**.
  Each shifted row needs its own op in the `op_log` for sync to converge
  (`move_ops.rs:158-159` appends exactly one `MoveBlock` op today). That is a
  meaningful sync-payload and conflict-surface increase — concurrent renumbers
  on two devices can fight. Mitigate by appending a single
  "reposition siblings" op or by gapping positions (see c).

**(b) Fractional / LexoRank-style ordering key (most robust, larger change).**
Replace the integer `position` with a string/rational rank; "insert between X and
Y" computes a key strictly between them with no neighbor mutation.

- _Pros:_ O(1) moves, **no sibling renumber**, so the op-log stays one-op-per-move
  and sync conflicts are minimal; "before first" is always `> 0`. Naturally kills
  all four bugs and the ULID-tiebreak ambiguity.
- _Cons:_ schema migration of every block's `position`; the `ORDER BY position`
  in `hierarchy.rs:69` / `pages.rs:372` and the `MAX(position)+1` create path in
  `crud.rs:201-208` all change; rank-rebalancing needed when keys collide after
  many inserts. Largest blast radius, but the only option that makes moves truly
  conflict-light.

**(c) Minimum viable: gap + clamp + renumber-on-collision.** Create blocks with
gaps (`MAX(position) + GAP`), have `computePosition` use the midpoint of the gap
(so adjacent inserts don't collide), clamp the "before first" case to
`firstPos / 2` (or renumber only that group when the gap is exhausted), and never
emit `<= 0`.

- _Pros:_ smallest change; most moves touch one row; preserves the integer
  scheme and most of the existing code.
- _Cons:_ still needs an occasional renumber when a gap fills; the frontend
  `midpointPosition`/`computePosition` logic must agree exactly with the backend
  on tie-breaking, which is fragile. A stopgap, not a cure.

Whichever path is chosen, **drop the `position ASC, id ASC` ULID tiebreak as a
load-bearing ordering mechanism** (`pages.rs:372`, `hierarchy.rs:69`): it is the
silent disambiguator that turns "collision" into "wrong place" instead of a
loud failure. It should remain only as a deterministic last resort, never as the
thing that decides user-visible order.

---

## 3. Interaction / visual UX review

### Drop indicator

A 5px primary-colored pill renders above the over-target row, left-indented to
the **projected** depth: `SortableBlockWrapper.tsx:141-146`
(`marginLeft: calc(var(--indent-width) * projected.depth)`), and a matching one
for the end-of-list sentinel (`BlockListRenderer.tsx:266-271`). This is clear
and correctly previews the landing depth. Supporting cues are good: the dragged
source row both fades to `opacity: 0.35` and gets a dashed outline
(`SortableBlock.tsx:195`, `226`), the over-target _and_ source rows preview the
projected indent (`SortableBlockWrapper.tsx:91-94`), and faint full-height
vertical indent guides appear during a drag (`BlockListRenderer.tsx:179`,
`231-248`). **Critique:** the indicator only renders on the row the cursor is
over (`overId === block.id`); with the empty-pill overlay (below) and a fast
drag the user can briefly lose any sign of _where_ the drop will land between
rows. Consider a persistent gap-style indicator that survives between hover
targets.

### DEAD_ZONE_PX (20px) for indent

`DEAD_ZONE_PX = 20` (`tree-utils.ts:17`) suppresses small horizontal movement
before any indent change, applied in both the sentinel and normal branches
(`tree-utils.ts:179-181`, `211-213`). With `INDENT_WIDTH = 24`
(`SortableBlock.tsx:41`), 20px is **83% of one indent level** — a deliberately
sticky threshold that, combined with the `DragIndentGuides` snap-to-grid lines,
reads as intentional rather than laggy. This is a reasonable choice. Minor
risk: a near-83%-of-indent dead zone can feel "stuck" to users who expect indent
at the halfway point; worth a quick dogfood. It is **not** user-configurable and
ignores any indent-density preference, but that is acceptable.

### Drag-handle discoverability / affordance

The grip (`GripVertical`) lives in a 68px gutter and is **hidden at rest**
(`opacity-0`, `pointer-events-none`), revealed only on row hover / focus-within
/ `.block-active` (`BlockGutterControls.tsx:36-37`, `158-184`). The comment at
`158-172` documents a deliberate reversal of an earlier always-visible grip
(#370) to keep the gutter calm. **Critique:** this is the calm-vs-discoverable
tradeoff — a first-time user has _no_ persistent visual hint that rows are
draggable. There is no onboarding affordance and the whole row is **not** a drag
handle (only the grip is). For a power-user outliner this is defensible, but a
subtle always-on grip at very low opacity, or a one-time coach-mark, would help
discoverability. The handle correctly exposes `aria-keyshortcuts`
(`BlockGutterControls.tsx:177`) and `cursor-grab`.

### DragOverlay is an empty pill (no content preview)

The overlay is a tiny `h-1.5 w-20` primary pill with **no block content**,
`pointer-events-none`, `aria-hidden`, `dropAnimation={null}`
(`BlockDndOverlay.tsx:39-47`). The stated rationale (lines 36-38) is that an
empty overlay lets the user see the list reflow underneath. **Assessment:** this
is a defensible and somewhat unusual choice. It works _because_ the source row
stays visible (faded + outlined) and the drop indicator + projected-depth
previews carry the "where will it land" information. The downside is the dragged
_identity_ is ambiguous during fast multi-row drags — the user tracks a
featureless dot, not their block. For deeply nested subtree drags (where the
whole subtree moves), a small "N blocks" count badge on the pill would reduce
ambiguity without reintroducing a heavy content preview.

### Auto-scroll

`useAutoScrollOnDrag` (`useAutoScrollOnDrag.ts`) runs a RAF loop while dragging,
scrolling when the pointer is within `SCROLL_ZONE = 50px` of the container edge,
speed ramping to `MAX_SPEED = 15px/frame` (~900px/s) proportional to edge
proximity (lines 23-26, 60-82). It correctly **honors
`prefers-reduced-motion`** by skipping the loop entirely (lines 53-58) while
still tracking the pointer so the drag itself works. This is well-implemented.
One caveat: dnd-kit's own `autoScroll` is not explicitly configured on the
`DndContext` (`BlockTree.tsx:736-744`), so this hook is the sole edge-scroll
mechanism — fine, but means scroll-while-drag depends on the
`scrollContainerRef` being threaded correctly; the hook falls back to an
internal ref (`useBlockDnD.ts:79-80`) which would no-op if the real scroll
container isn't passed.

### Touch long-press (250ms) vs desktop 8px activation

Sensors: desktop `PointerSensor` activates at `{ distance: 8 }`; mobile at
`{ delay: 250, tolerance: 5 }` (`useBlockDnD.ts:106-111`). The 250ms press-hold
on touch is necessary to disambiguate drag from scroll/tap and from the
long-press context menu, and the iOS callout/magnifier is suppressed
(`SortableBlock.tsx:222`). Note there is a separate, longer 400ms long-press for
the context menu (referenced in `SortableBlock.tsx` comment at 219-221 via
`useBlockTouchLongPress`), so 250ms-drag vs 400ms-menu can race on touch — the
code guards this by clearing the long-press timer once `isDragging` flips
(`SortableBlock.tsx:183-188`). Reasonable, but the 250/400 window is tight and
worth a touch-device dogfood. The touch drag handle also carries an
`aria-label` hint since tooltips never fire on touch (`BlockGutterControls.tsx:193-206`).

### Collapsed / nested subtrees during drag

Descendants of the dragged block are excluded from the visible/sortable list for
the duration of the drag (`useBlockDnD.ts:86-95` via `getDragDescendants`), so a
parent drags as a unit and the projection math doesn't trip over its own
children. `dnd-pipeline.test.ts:268-291` confirms a moved parent keeps its
subtree intact (modulo BUG 1, which also defeats _subtree_ downward drags —
`dnd-pipeline.test.ts:282-290`). Collapsed subtrees: the input list is
`collapsedVisible` (collapsed children already pruned), so a collapsed parent
moves its hidden descendants implicitly via the backend page-id cascade
(`move_ops.rs:206-226`). This is correct. The one rough edge is purely the
position bugs above — the _structure_ moves fine; the _order among siblings_ is
what breaks.

### Dead fast-path / full reload on every drag (architectural defect, P1)

In `handleDragEnd`, the branch condition is
`if (isSentinel || depthChanged || parentChanged || active.id !== over.id)`
(`useBlockDnD.ts:159`). Because `active.id !== over.id` is true for **virtually
every** real drag (you almost never drop exactly onto yourself), this branch
swallows nearly all drags into the `moveToParent` path — and `moveToParent`
does `await moveBlock(...)` **followed by a full `await get().load()` tree
refetch** (`page-blocks.ts:517-535`). The in-place `reorder()` splice path
(lines 184-200), which updates state without a refetch, is therefore
**effectively dead code for pointer drags**. Consequence: every drag triggers a
full page reload — IPC round-trip + re-flatten + re-render of the whole tree —
risking jank and focus/scroll jumps on large pages (the code even adds a
`setFocused(blockId)` + `scrollIntoView` workaround for exactly this,
`useBlockDnD.ts:165-178`). The keyboard `moveUp`/`moveDown` paths, by contrast,
splice locally and avoid the reload (`page-blocks.ts:626-676`, `695-743`),
proving the optimistic path is feasible for drags too. **Recommend** restructuring
the branch so same-parent reorders take the local-splice path, and reserving the
reload for true cross-parent / depth-changing moves (and even those can splice
once the position scheme is fixed).

---

## 4. Keyboard & accessibility review

### Discoverability of move / indent shortcuts

All move/indent bindings are catalogued and surfaced in the keyboard-shortcuts
help dialog + Settings: `indentBlock` `Ctrl+Shift+→`, `dedentBlock`
`Ctrl+Shift+←` (`catalog.ts:53-64`), `moveBlockUp` `Ctrl+Shift+↑`,
`moveBlockDown` `Ctrl+Shift+↓` (`catalog.ts:77-88`). The drag handle also
advertises the reorder shortcut via `aria-keyshortcuts`
(`BlockGutterControls.tsx:177`, `202`). Discoverability is **good** — these are
documented, rebindable, and exposed to AT. Minor: the catalog entries for
indent/move carry no `condition` qualifier, so the help dialog doesn't tell the
user these only act on a focused block.

### Screen-reader announcements

Every keyboard move emits a polite live-region announcement via `announce()`:
`blockIndented` / `blockDedented` (`useBlockKeyboardHandlers.ts:156`, `165`),
`blockMovedUp` / `blockMovedDown` (lines 179, 193). `announce()`
(`src/lib/announcer.ts`) is a well-built singleton `aria-live="polite"`,
`role="status"`, `aria-atomic` region that clears-then-sets on a RAF to force
re-read (lines 18-56) and coalesces identical messages within 500ms (lines
14-15, 42-48). **Critique:** the announcements are _fire-and-forget_ — they
fire **before** the async `moveUp/moveDown/indent/dedent` promise resolves and
regardless of success. So when a move **fails** (BUGs 3/4: position rejected),
the SR user hears "Block moved up" while the block did **not** move and an error
toast appears — a false confirmation. The drag path's SR region announces only
`Moving to depth N` (`BlockDndOverlay.tsx:29-35`), which describes depth but
**not** the final landing position or success/failure. Recommend: announce on
promise resolution, and announce a distinct failure message on rejection.

### Keyboard drag via KeyboardSensor

A `KeyboardSensor` with `sortableKeyboardCoordinates` is wired
(`useBlockDnD.ts:110`), so dnd-kit's keyboard drag (focus handle → Space →
arrows → Space) is technically available. **However**, the handle is in a gutter
that is `opacity-0`/`pointer-events-none` until hover/focus
(`BlockGutterControls.tsx:36-37`); it does become focusable via
`group-focus-within`/`focus-visible` (so tabbing to it reveals it), but it is
**not** in a discoverable tab path next to the content, and the empty overlay +
"Moving to depth N" announcement give a keyboard-drag user very little spatial
feedback. In practice keyboard _reordering_ is far better served by the explicit
`Ctrl+Shift+↑/↓/←/→` shortcuts, which is the right primary mechanism.

### Reachable without a mouse?

**Yes** for move/indent: the `Ctrl+Shift`+arrow shortcuts route through
`useBlockKeyboardHandlers` → store actions and need no pointer. The
`aria-keyshortcuts` and help-dialog entries make them discoverable. The
keyboard-drag fallback exists but is secondary. The main accessibility gap is
the **false-success announcement on failed moves** (above) and the fact that the
underlying position bugs mean a keyboard move-to-top (`Ctrl+Shift+↑` onto a
position-1 sibling) _fails_ — so an AT user is told it worked when it didn't
(BUG 3).

---

## Testing-gap risk: the web mock is more permissive than the real backend

The bugs are **partly hidden** in the web / e2e harness because the Tauri mock
diverges from the real backend on exactly the two axes that cause these bugs:

- **Mock `move_block` accepts `position <= 0`.** It does a bare
  `b['position'] = a['newPosition']` with **no positivity validation**
  (`src/lib/tauri-mock/handlers.ts:1168` ff., the assignment around 1175). The
  real backend rejects it (`move_ops.rs:43-47`). So BUGs 3 & 4 — which
  _throw_ against the real backend — **silently succeed** against the mock.
- **Mock `list_blocks` sorts by position only, no `id` tiebreak.**
  `handlers.ts:464-465` (`items.sort((x,y) => posX - posY)`), a stable sort, so
  equal positions keep insertion order rather than ULID order. The real backend
  tie-breaks by `id ASC` (`pages.rs:372`, `hierarchy.rs:69`). So BUGs 1 & 2 —
  whose wrong-place behavior depends on the ULID tiebreak — manifest
  _differently_ (or not at all) in the mock.

Note one subtlety: the mock `load_page_subtree` _does_ tie-break by id
(`handlers.ts:585-590`), but the frontend `buildFlatTree` then **re-sorts
siblings by position only** with no id tiebreak (`tree-utils.ts:63-66`), using a
stable sort — so even the mock page-tree path can mask the ULID-ordering bug.

**Implication:** Playwright / unit suites running against the mock can show
drag-and-drop "working" while the shipped Tauri app exhibits all four bugs. Any
DnD regression test that matters must run against the real backend semantics —
which is exactly what `dnd-pipeline.test.ts` does (it inlines a faithful
`backendMove` + `listOrder` model). Recommend: **align the mock** with the real
backend (reject `position <= 0`; add `id ASC` tiebreak in `list_blocks` and in
`buildFlatTree`) so the mock stops papering over backend-only failures.

---

## 5. Prioritized recommendations

| # | Priority | Effort | Recommendation |
|---|----------|--------|----------------|
| R1 | **P0** | **L** | Fix the position scheme so moves never collide or go ≤ 0: backend "make room" renumber in the `move_block` transaction (`move_ops.rs:162`), or migrate to a fractional/LexoRank key. Kills BUGs 1–4 at the source. Plan the op-log/sync impact (renumber = N ops, or one batch op). |
| R2 | **P0** | **S** | Pass the projection-adjusted index (`overIndex > activeIndex ? overIndex-1 : overIndex`) into `computePosition` (`useBlockDnD.ts:161-164`) to fix the downward-drag off-by-one (BUG 1) independent of R1. |
| R3 | **P1** | **S** | Stop emitting `position <= 0` from the frontend: `computePosition`'s `firstPos - 1` (`tree-utils.ts:295-296`), `computeReorderPosition`'s `firstSiblingPos - 1` (`page-blocks.ts:143`), and `moveUp`'s `prevSibling.position - 1` (`page-blocks.ts:624`). Pairs with R1; until R1 lands, clamp/renumber instead of subtracting below 1. |
| R4 | **P1** | **M** | Align the Tauri mock with the real backend: reject `position <= 0` in mock `move_block` (`handlers.ts:1168`+) and add `id ASC` tiebreak in mock `list_blocks` (`handlers.ts:465`) **and** in `buildFlatTree` (`tree-utils.ts:63-66`). Removes the testing blind spot. |
| R5 | **P1** | **M** | Make pointer drags take the optimistic local-splice path instead of a full `load()` refetch: restructure the `handleDragEnd` branch (`useBlockDnD.ts:159`) so same-parent reorders avoid `moveToParent`'s `await get().load()` (`page-blocks.ts:522`). Mirror the existing `moveUp`/`moveDown` splice logic. |
| R6 | **P1** | **S** | Announce keyboard moves on promise **resolution**, with a distinct failure message on rejection (`useBlockKeyboardHandlers.ts:156,165,179,193`); today a failed move (BUG 3/4) still announces success to screen readers. |
| R7 | **P2** | **S** | Fix `dedent` position collision: `parent.position + 1` (`page-blocks.ts:572`) can equal the parent's next sibling's position; route through the same renumber/fractional logic as R1. |
| R8 | **P2** | **S** | Improve drag identity feedback: add a "N blocks" badge to the empty overlay pill (`BlockDndOverlay.tsx:39-47`) for subtree drags, and/or a persistent gap-style drop indicator that survives between hover targets. |
| R9 | **P2** | **S** | Add a low-opacity always-on grip or one-time coach-mark for drag discoverability (`BlockGutterControls.tsx:158-184`); the handle is invisible until hover today. |

---

_Reviewer note: every file:line citation above was opened and read during this
review. The four correctness bugs are independently locked in by passing tests
in `src/lib/__tests__/dnd-pipeline.test.ts`; deleting an `it.fails` there will
turn red precisely when the corresponding bug is fixed._
