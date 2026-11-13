# Session 4040 — History badges the ops an MCP agent wrote (#6535)

Finished the `claude/6535-agent-badge` branch from the overnight handover (#6667), the last box of #6535. The builder ran longest of the night's agents and was close to done; this session reviewed the inherited diff, rebased it (one conflict in `docs/FEATURE-MAP.md`, where #6645 and #6655 had extended the same two rows), and gated it.

What it does: `HistoryEntry` gains `agent: Option<String>`, the name in `op_log.origin = 'agent:<name>'`, filled by a `CASE WHEN` in each of the five statements that select history rows (`list_block_history`, the two whole-vault keyset statements, `list_single_page_history`, and the positional undo lookup in `commands/history.rs`), and left out of the JSON for every other origin. The issue asked for `origin`; the builder exposed only the agent's name, which is what the row shows, and kept the user and sync origins off the wire. `HistoryItemCore` renders a bot badge with the name and a screen-reader sentence ("Written by agent …"). The mock projects the same field from its op log, which gains an optional `origin`.

Conformance: `HISTORY_ATTRS` / `HISTORY_TOKEN` gain `agent`, so every history query step now pins it, and `query_history.json`'s rows read `#agent=null`. The new `query_history_agent.json` appends two ops under an agent: the Rust runner scopes `append_local_op` in that agent's `ACTOR`, as an MCP tool call does, and the TS runner stamps the same `origin` on the mock's ops. Each of the four listing statements serves an agent row there.

Real backend: `e2e-tauri/history-agent-badge.e2e.ts` writes a block through the MCP socket, rewrites it in the editor, and checks that History badges the agent's `create_block` and not the user's `edit_block`. It has not run locally (no WebdriverIO in this container); CI's real-backend lane is its first run.

Docs: `agent-access.md` no longer says History cannot tell agent ops from the user's; `views.md` and `FEATURE-MAP.md` name the badge.

Ran: `just gen-sqlx` and the specta bindings regeneration (both clean against the branch), nextest over the history, conformance and pagination tests, `cargo clippy --workspace --all-targets -- -D warnings`, and vitest over the History components and the mock (1970 pass).
