# PEND-38 — Import progress streaming over `Channel<T>` (PEND-06 Tier 3)

> **Status:** **deferred** — needs the import pipeline restructured before
> the channel adoption is meaningful. PEND-06 Tier 1 (sync progress)
> shipped in 0.1.18 + 0.1.19; PEND-06 Tier 2 (file transfer per-frame
> progress) shipped this session. Tier 3 (this item) is the remaining
> third candidate flow. Filed as a separate item because the import
> restructure is genuinely larger scope than the channel work itself.

## Why this is its own item, not just a Tier-3 line in PEND-06

`import_markdown` (`src-tauri/src/commands/import_cmds.rs`) runs the
parse + apply phases inside a **single SQL transaction** — it's
all-or-nothing for atomicity. The Tier 1+2 plumbing is mechanical
("emit `SyncEvent::FileProgress` between binary frames"), but Tier 3
hits a wall: streaming progress mid-transaction means you can't roll
back cleanly if the parse-apply boundary fails halfway through. The
transactional model is the right design choice — mixing in per-block
progress requires splitting it apart.

The two pieces — restructuring the import pipeline, and emitting
progress through a channel — are independently sized:

- **Restructure (architectural, high cost):** split `import_markdown`
  into a parse phase (fast, in-memory, builds the op list) + an apply
  phase (per-block savepoints inside an outer transaction). Rationale
  must include error recovery semantics (does a mid-import failure
  leave the DB partially populated? do we surface "applied N of M"
  to the user?).
- **Channel emission (mechanical, low cost):** once the apply phase has
  per-block savepoints, threading `Channel<SyncProgressUpdate>` through
  it is the same shape as Tier 2 — extend the tagged enum with an
  `Import { phase, blocks_done, blocks_total }` variant, emit between
  savepoints.

Doing the channel work without the restructure produces no UX win
(progress jumps from 0 to 100% at commit), so this item is the
restructure with the channel as a follow-on emission.

## Cost

| Phase | Effort | Notes |
| --- | --- | --- |
| Restructure (parse + apply split with per-block savepoints) | L (~1-2 weeks) | Affects error semantics; needs test coverage for partial-failure recovery |
| Channel emission (extend `SyncProgressUpdate::Import`) | S (~2-4h) | Mechanical once the apply phase is per-block |

## User value

**Medium.** Imports are rare events — the user-observed pain is "is it
stuck?" on a multi-thousand-block import. Lower priority than sync
progress (every-minute event) and file transfer (every-attachment
event), so Tier 3's deferral has been the right call.

## When to revisit

- A user reports a stuck import or asks for cancellation.
- Someone is already touching the import transactional model for an
  unrelated reason (CSV import, drag-drop bulk paste, etc.) and the
  restructure is local to that work.
- After a major bulk-import marketing push where "10k blocks in 30
  seconds" is a headline feature; the user-facing progress is then a
  meaningful win.

## Dependencies / blockers

- None today. The Tier 1+2 work in PEND-06 finalised the
  `SyncProgressUpdate` tagged-enum shape; adding a third variant is
  additive.

## Related

- [`PEND-06-channel-adoption.md`](PEND-06-channel-adoption.md) —
  Tier 1+2 shipped. Tier 3's pre-work spec lives there.
- `src-tauri/src/commands/import_cmds.rs` — current single-transaction
  implementation.
