# Session 2318 — Settings lists, creates and revokes MCP agents

Step 3 of #5667, over step 2's `list_mcp_agents`, `create_mcp_agent` and
`revoke_mcp_agent`. Agents created here take effect only once step 4 makes
the bridge send a token; the card says so.

**Agents card** (`AgentList.tsx`), between the status card and Recent
activity, shown whether or not the MCP switch is on.
- **Empty state:** "No agents yet", the migration sentence, and Add agent.
- **Rows:** the name; a mode badge, with read-write in the destructive tone;
  the spaces ("All spaces", their names, or "No spaces left"); and last
  used.
- **Copy buttons:** they build the Claude Desktop or Claude Code snippet on
  click, so the token never sits in the DOM.
- **Revoke:** goes through a `ConfirmDialog`.
- **Labels:** each row's buttons carry the agent's name in their
  `aria-label`.

**Create dialog** (`CreateAgentDialog.tsx`; a bottom sheet on touch):
- a name input;
- a mode toggle, read-only by default, with the journal note;
- "All spaces, including new ones", which, when unchecked, reveals a
  checkbox per space in a `fieldset`;
- a duplicate name shows inline as an alert, and any other refusal keeps the
  dialog open, logs and toasts;
- focus returns to Add agent after a create or a revoke.

**Snippets** (`agent-config.ts`) follow the design's formats. A name with no
usable letter or digit gets the slug `agaric-agent`. They point at today's
read-only socket path until step 4 merges the sockets. Recent activity now
shows the agent's name on agent rows.

`scripts/check-ipc-error-path.mjs` gains one allowlist entry: the dialog's
rejection path is exercised through `AgentList.test.tsx`.

**Tests.** Twenty mutations were each killed at the predicted assertion,
including two Playwright focus checks. One mutation of the dialog's initial
mode was equivalent, because the dialog resets on open; the reset is now
what's tested.

Gates: vitest (9 files, 434), `npm run typecheck`, oxlint, oxfmt, prek, and
the mcp-agents, agent-access and settings Playwright specs (60 at
`--repeat-each=3 --retries=0`).
