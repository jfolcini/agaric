# Session 3667 — #5364's Docs box

The last unticked box of #5364 that isn't a device check: the user docs for slice 2.

- Most of the box had already shipped with the PRs that built each piece:
  - the transcript format, `/meeting` and the *New meeting* dialog are in `docs/features/editor.md` (#6411, #5410);
  - the FEATURE-MAP *Media & attachments* row covers the recording layout, `/meeting` and the palette command;
  - `add_meeting` is in `docs/features/agent-access.md` (#6406).
- What was missing is `<% recording %>` in `docs/features/spaces.md`, beside the template variables the Templates view lists with it. It's documented there as what it is: a placeholder, not a variable.
  - On a block of its own, a meeting (`/meeting`, *New meeting*, MCP `add_meeting`) puts its recording block there, and with none the recording block opens the page (`add_meeting_inner`).
  - `/template` leaves that block out and keeps its children (#6432).
  - A journal day copies it as written: `expand_template_variables` keeps any name it does not know.
- The device-check boxes are the maintainer's and stay unticked.
