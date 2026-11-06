# Session 3614 — MCP `add_meeting`

The third PR of #5364 slice 2 (S4 in the build plan on #5410): an agent makes a meeting in one call through `add_meeting_inner`, the inner the app's dialog will call.

- `add_meeting { space_id, title?, date?, template?, page?, block_id?, audio_path?, transcript_path?, summary_markdown?, summary_path? }`:
  - A new meeting is linked from the end of that day's journal. `date` reads as `capture`'s does, and `template` and `page` take a title or an id.
  - `page` or `block_id` adds the files to an existing meeting.
  - Refused: both summaries, both targets, and `title`/`date`/`template` given with a target.
  - The paths go through `attach_file`'s checks (`check_source_file`, now naming its tool).
- `attach_file` and `add_meeting` share one dispatch arm (`FileTools`). That keeps `call_tool` under the line ceiling, shorter than before this PR.
- Two existing tests changed, with the coordinator's approval, as `mcp/AGENTS.md` asks of a new tool. `list_tools_advertises_the_rw_tools` lists the tool, and `each_write_tool_opens_one_command_transaction_5402` includes it. The 5402 test went red first, with the handler skipping its transaction: `("add_meeting", 0)` against `1`. The `tool_descriptions_rw` snapshot was regenerated with insta.
- Seven tests in `tools_rw/tests.rs`:
  - the page, template, summary, files, journal link, reloads, agent origin and one undo;
  - the refusals;
  - a template that is missing or not one;
  - adding to an existing meeting by page and by block;
  - a directory path;
  - another space;
  - the tool and `add_meeting_inner` making the same page.
  Plus a summariser test (`add_meeting — N files on <recording>, page <page>`, no title or filename).
- Falsified with 9 handler mutations, each killed by the test predicted: the two exclusivity checks, the target-arguments check, the journal day, the view reload, the summary file, the path check, the tool name and the template argument.
- Docs: `agent-access.md`, `integrations.md`, `threat-model.md`, the `instructions()` primer and the `tools_rw.rs` table.
