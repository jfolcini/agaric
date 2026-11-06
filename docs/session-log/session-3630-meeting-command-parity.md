# Session 3630 — the app's `add_meeting` and the MCP tool make the same meeting

The seventh PR of #5364 slice 2, tests only. It covers the slice's "the Tauri command and the MCP tool, given the same input, produce the same page, blocks and attachments" box.

- `add_meeting_makes_what_the_app_command_makes_5364` (`mcp/tools_rw/tests.rs`) makes one meeting through the MCP tool, and one through the app command's input: `AddMeetingInput::into_request` into `add_meeting_inner`, which is all the command does beyond resolving the app data dir and capturing the op refs. Each goes in its own space, from the same template. It asserts the same page blocks, the same attachments under the same suffixed names, and both links on the same journal day. The neighbouring test compared the tool with a hand-built `AddMeetingRequest`, which skipped `into_request`.
- Red: these mutations of `into_request` each failed the new test on its own assertion:
  - dropping the template or the summary text broke the page blocks;
  - dropping the transcript broke the attachments;
  - linking from the day after broke the journal day.
- Swapping the audio and transcript also failed, but on the backend's refusal of a transcript as audio, not on the comparison, so it is not counted.
- `cargo clippy --workspace --all-targets -- -D warnings` is clean.
