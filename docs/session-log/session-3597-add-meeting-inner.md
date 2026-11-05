# Session 3597 — `add_meeting_inner`

The second PR of #5364 slice 2 (S4 in the build plan on #5410): the backend that makes a meeting, in one transaction. No caller yet. The MCP `add_meeting` tool and the app's dialog call it in the next PRs. Cut from #6395's branch, since a meeting sets the `meeting_date` built-in that #6395 adds.

- `add_meeting_inner` (`commands/meeting_attachments.rs`, a name `e2e-related` maps to `@attachments`):
  - A new meeting is the page `<Title> <YYYY-MM-DD>` (*Meeting* when the title is blank), tagged `#meeting` (created in the space if missing) with `meeting_date`.
  - The chosen template page is copied under it, with its variables expanded against the meeting date and title rather than the clock. A template block reading `<% recording %>` becomes the recording block; without one, the recording block is the page's first block.
  - A summary given as text is written just above the recording block. The audio, transcript and summary files go onto that block as `<name>.transcript.md` and `<name>.summary.md`.
  - The page is linked from the given block (appended to its content) or from the end of the day's journal, which is created if missing.
  - Given a block, or a page, it adds the files to an existing meeting instead. A page's recording block is its first block holding an attachment, else a new block at its top.
- The files are written before the transaction and removed if it fails. A taken title, a page that is not a template of the space, audio that is not audio and a target in another space are refused with nothing written.
- One `revert_ops` of the captured refs takes the whole meeting back: page, template copy, tag, link edit and attachments.
- Splits along the `_in_tx` pattern, with no change for existing callers: `persist_attachment_in_tx` and `write_attachment_bytes` (`attachments.rs`), and `create_tag_in_space_in_tx` (`blocks/crud.rs`). The journal's template expander now takes the page title (`expand_template_variables`); the journal still passes the day.
- Not here: dropping `<% recording %>` from a journal-template copy (Q15) goes with `/template`'s drop in S5b. It needs a filter in `copy_page_blocks_in_tx`, which is in a file another session has open.
- Red: the 12 tests in `tests/commands/meeting_cmd_tests.rs` were written after the code, so each behaviour was falsified instead. 14 mutations, each applied and restored by one script: the title, the date, the tag, the expansion's title and date, the placeholder, the summary's slot, the block link, the journal link's slot, the cleanup, the suffix, the page's recording block, the audio check and the taken-title check. Each reddened the test predicted.
- cargo-nextest is still not installable here; Rust runs used `cargo test` per binary. The disk filled once; clearing `target/debug/incremental` freed it.
