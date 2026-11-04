# Session 3260 — bench-slo counts the Document dialect's blocks

The weekly `bench-slo` lane went red on 2026-11-02 (#3394, and #3388 mirrors
it): `interactive_slo`'s MCP `get_page_markdown` shape probe found 0 of the
fixture's 250 blocks. The read was fine. #6212 moved the MCP page tools to the
Document dialect, which writes a block as `content ^ID` rather than a `- `
bullet, and the probe still counted `- ` lines. Nothing in PR CI runs this
lane, so the stale counter surfaced only on the next Monday.

The counter now counts lines whose last word is a `^ID` anchor, which the
Document dialect puts on every block's last line. `get_journal` renders the
same way, and its probe, which never ran because the panic aborted the
lane first, uses the same counter. The Tauri `export_page_markdown` probe
keeps counting bullets: export still writes them, and that probe passed.

Ran: `rustfmt --check` on the bench. The bench itself is verified by a
`lanes=bench-slo` dispatch on the branch, per `src-tauri/benches/AGENTS.md`.
