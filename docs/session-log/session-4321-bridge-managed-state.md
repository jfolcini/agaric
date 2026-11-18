# Session 4321: the bridge manages the Settings panels' state, and the `@real-only` tag

Stage 0, gap G2 of #6926 (#6529).

**Gap:** `HeadlessApp` managed only what `register_managed_state` registers. Boot also manages, beside its daemons:
- MCP: `McpLifecycle`, `McpToggleGate`, `McpActivityRing`;
- the mirror: `MirrorState`;
- sync status: `MdnsStatusState`, `BindExposureStatusState`.

On the bridge, tauri refused every command that reads one of these as unmanaged, so the MCP, mirror and sync Settings panels showed an error.

**Fix:** `HeadlessApp::over` manages these states with their boot defaults. No daemon starts, so the panels read an idle MCP server, an unset mirror folder and clean sync status.

**Tag:** the mock project now greps out `@real-only`, the mirror of `@mock-only`. It is for tests that only the real backend can pass, such as BM25 ranking or a second page of results.

**Docs:** G1 (#6926) showed that `read_attachment`'s raw bytes already cross the bridge, as an array of numbers. The `invoke_with` doc, the `bridge.ts` header and `e2e/AGENTS.md` said they did not; all three now say they do. `e2e/AGENTS.md` also says that no daemon runs and documents `@real-only`.

**Test:** `the_settings_status_reads_answer_on_a_headless_app` invokes `get_mcp_status`, `get_mcp_recent_activity`, `get_mirror_status`, `get_mdns_status` and `get_bind_exposure_status` through a `HeadlessApp`. Before the fix it failed with `state not managed for field \`lifecycle\` on command \`get_mcp_status\``.
