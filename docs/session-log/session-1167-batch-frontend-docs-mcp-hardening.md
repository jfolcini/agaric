# Session 1167 — frontend/docs batch + MCP-hardening batch

Autonomous `/loop /batch-issues` session. Shipped as independent PRs, pipelined against CI.

## #2770 — WeeklyView reschedule-by-drag becomes reachable (F-32)

The weekly-view reschedule drop zone (`RescheduleDropZone`, shipped in #2708) had no
reachable drag source: in weekly mode `DaySection` renders each day's blocks through the
shared `BlockTree → SortableBlock` editor row, which never set the
`application/x-block-reschedule` payload. The gesture was physically impossible in the
shipped app (only synthetically driven in the e2e).

Fix (Option (a), approved by the maintainer): a new opt-in React Context
(`src/hooks/useRescheduleDragSource.tsx`) lets `WeeklyView` mark its subtree as a drag
source without threading a prop through `BlockTree`. `SortableBlock`'s outer row becomes a
native drag source, gated on `useRescheduleDragSourceEnabled() && !isTouchDevice`, so
DailyView, the page editor, StreamView and MonthlyView are untouched. dnd-kit reorder is
protected by `draggable={false}` on the grip handle; ProseMirror text selection by
`draggable={false}` on the `EditableBlock` wrapper. New unit tests + a real-gesture e2e
(`e2e/weekly-reschedule-drag.spec.ts`) that dispatches `dragstart` on the actual row so the
production `onDragStart` populates the DataTransfer.

## #2748 — dangling rustdoc intra-doc links in `task_locals`

After `task_locals` moved into `agaric-store` (#2621/#2718), `crate::mcp` resolves against
the agaric-store root and dangles (mcp lives in the top-level crate); `ACTOR::scope` is
unresolvable regardless (a `tokio::task_local!` static, not a type). Both demoted to
code-spans; the `crate::op_log` links still resolve (op_log also lives in agaric-store) and
stay as links. `cargo doc -p agaric-store --no-deps`: task_locals warnings 2 → 0.

## MCP-hardening batch — one PR (Closes #2719 #2720 #2721 #2727 #2728)

Five deep-review MCP findings fixed together in an isolated worktree:

- **#2719** — the "read-only" MCP surface could create a journal page for any date in any
  space (unbounded append-only op_log growth). Bounded the RO `journal_for_date` create
  branch to a date window; out-of-window missing dates return NotFound instead of creating.
  Corrected the AGENTS.md contract + in-code docs that falsely claimed guaranteed-no-mutation.
- **#2720** — Windows named-pipe threat-model was wrong (default DACL is not owner-only) and
  no explicit security descriptor was set, leaving the fixed pipe name squattable. Set an
  explicit per-user DACL, escalated bind failure on the fixed name to a real error, corrected
  the comments.
- **#2721** — rapid disable→enable toggle could leave the surface reported enabled with no
  listener bound. The disable branch now bounded-waits for the accept loop to exit before
  releasing the toggle gate (both RO and RW).
- **#2727** — the Windows successor-pipe `create()` used `?`, so a transient failure
  permanently killed the accept loop. Wrapped it in the same backoff-retry as `connect()`.
- **#2728** — RW-only agents had no in-band way to discover the mandatory `space_id`. Added
  the pure-read `list_spaces` tool to the RW registry (reusing the RO data function).
