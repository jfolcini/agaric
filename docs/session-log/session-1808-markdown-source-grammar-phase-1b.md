# Session 1808 — markdown source mode, phase 1b

This session took over #5140's Phase 1b from the WIP commit session 1805 handed off. The job was to review it as a reviewer, prove its tests, and ship it. Phase 1b adds the Source grammar: the buffer the per-page markdown source mode will edit. Its behaviour follows the #5140 comment that re-plans Phase 1.

**What 1b is.**
- `RenderMode { Export, Source }` with a shared `render_block_tree`, and a `render_page_source` entry point that Phase 2 calls.
- A lossless `parse_source_outline` next to the importer's normalising parse. It keeps `((ULID))` refs, spacing, interior blank lines and continuation indentation.
- A Source-only task checkbox (`[ ]`, `[x]`, `[/]`, `[-]`) with a `\[ ] ` escape.
- A humanise check: a page or tag name is written only when the importer's own resolver maps it back to the same id. `NameSnapshot` stays empty until Phase 2 loads it.

**Review.** No correctness defect found. #5148's note 2, that `ends_in_code` should be one plain mechanism, was already folded into the WIP: a push beside each block push, an indexed assignment on a continuation line, nothing on a property line. Note 1 was fixed with it, by `append_block_anchor`'s `rsplit_once`. One visibility cut: `RenderMode` was `pub`, but only private functions use it.

**Falsification.** A subagent ran 26 single-site mutations against copies, and 24 turned at least one test red. Both mutations the task named went red:
- Reinstating `strip_block_refs_counted` in Source mode reddened the proptest and `block_refs_and_spacing_are_kept`.
- Dropping the blank-line buffer reddened the proptest and the blank-line unit test.

Two mutations survived, and a third was caught only by the proptest. The fixtures now catch all three, each shown red against a copy:
- Forcing `is_code = false` in the humanise check survived because the ```` ``` ```` fixture's link was also inside a single-backtick span pair. The fixture now uses a four-backtick fence, so only the fence keeps the link raw.
- Writing attachment lines in Source mode survived because no Source fixture had an attachment. The snapshot fixture now has one.
- Dropping `blank_run.clear()` was caught only by the proptest. The unit test now has a second continuation line after the blank run.

The test for an explicit `todo_state::` line winning over the checkbox shares its oracle with the listStyle test (`attach_property_line` appends). It stays as the Source grammar's statement of that precedence for hand-edited buffers.

**Verified.**
- `cargo nextest run --workspace -E 'test(/export|import|markdown|anchor|fence|list_style|2716|4552|2866|5140/)'` passed 346 of 346 on the rebased WIP, with no edits to existing expected strings.
- The 23 phase-1b tests pass after the fixture changes.

**Known, not changed here.**
- A same-page ref target whose content is an unterminated fence still loses its anchor. The marker lands inside the still-open fence, and this predates 1b.
- The Source parse excludes four inputs, listed in `markdown_source_tests.rs`'s module docs: a `\r` in content, a custom property value with surrounding whitespace or a newline, a fence with no closing delimiter in its block, and tabs as bullet indentation in a hand-edited buffer.

**Also prepared.** A follow-up to #5149's review note: `pasteBlocks` passes a per-paste `coalesceKey`, so a slow level no longer splits one paste into several undo entries. The test steps `Date.now` past the window, and both new tests were falsified against a copy. It is on `claude/5140-review-notes-1b`, and its PR waits until 1b merges, so it can batch 1b's own review notes.

**Phase 2, planned against the code.** A new query is not needed after all: `agaric_store::space::resolve_block_space` already reads a page's space inside a transaction. The re-plan comment on #5140 lists the other corrections.
