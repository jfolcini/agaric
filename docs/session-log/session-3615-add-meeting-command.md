# Session 3615 — the `add_meeting` command and its mock twin

The fourth PR of #5364 slice 2 (S5a-1 in the build plan on #5410): the Tauri command the *New meeting* dialog will call, its hand-written mock twin, and the conformance fixture that pins one to the other. No UI yet; the dialog and `/meeting` are S5a-2.

- `add_meeting(input: AddMeetingInput) -> WithOps<MeetingResult>` (`commands/meeting_attachments.rs`) wraps `add_meeting_inner` in `capture_op_refs`, so the dialog's toast can offer one Undo for the whole meeting. `AddMeetingInput` is the dialog's form: title, `YYYY-MM-DD` date, template, the block to link from (the day's journal without one), and the audio, transcript and summary, the summary as text or a file. `into_request` refuses a malformed date and both summaries.
- The mock twin (`tauri-mock/handlers/meetings.ts`) composes the domain handlers in the backend's op order. It checks every refusal before its first write, since the mock has no rollback. The journal-template copy and the template-variable expander now take a destination and a title (`copyTemplateBlocks`, `expandJournalTemplateVariables`). Approximations, stated in its header: the template copy is content and nesting only, as the journal's is, and a text summary is one block.
- `conformance/fixtures/meeting_add.json`, authored by the backend:
  - a meeting from a block, with a template, a text summary and two files;
  - the four refusals;
  - a meeting from the palette with a blank title and no template, linked from a day the call creates;
  - a `list_attachments` step for the files and their suffixes.
  Both runners resolve the labels inside `input`. Adding a mutating command moves `MUTATING_ARM_COUNT` from 68 to 69 and adds a `RETURN_SHAPE` row on each side, approved by the coordinator as the documented path.
- Red: `conformance-coverage.test.ts` failed with `["add_meeting"]` and no fixture before the fixture landed.
- Falsified: 7 mutations of the mock twin, each killed by the fixture: the summary slot, the suffix, the placeholder, the title variable, the taken title, the tag and the journal link. 2 mutations of `into_request`, each killed by its unit test: the link and the date.
- The vitest mock suite (65 files), the `command_integration` conformance tests, `ts_bindings_up_to_date`, clippy `--workspace --all-targets` and fmt all pass. One mutation run was killed mid-build (exit 137); the restore trap had not fired, so I restored the file from its backup and re-ran that mutation.
