# Session 3425 — Obsidian Tasks fields, read and written on task lines

#6277 D2 and D3 (decision 4), one PR. They ship together because D2 alone opened a data-loss window: a task whose stored text already ended in `📅 2026-01-01` read that date as a field in both the base and the edited buffer, so an Edit as Markdown save of that block dropped the text and stored no field. D3's escape closes it, pinned by `a_tasks_own_signifier_text_survives_an_edit_of_its_block`.

D2, reading. A checkbox task line's trailing `📅`, `⏳`, `🔺⏫🔼🔽⏬`, `🔁 every [N] unit[s] [when done]` and `✅` read into `due_date`, `scheduled_date`, `priority`, `repeat` (`+N…` or `.+N…`) and `completed_at`. This happens in the Rust scan and in the TS mirror, so import, paste, Edit as Markdown, MCP `append_markdown` and capture all read them. `✅` is read only on a done task. Any other signifier, and any value that does not parse, stays text and is counted in one warning. Paste and `append_markdown` now return the reader's warnings.

D3, writing. Every render mode writes a checkbox task's priority, rule, scheduled, due and done dates as signifiers at the end of its first line, before ` ^ULID`, in the Tasks plugin's order. Each signifier is checked by reading it back. A value that would not read back stays a `key::` line, and so does a rule Tasks cannot express or one with `repeat-until`/`repeat-count`. A task whose own text would not read back exactly gets a `\` before each signifier, which the reader removes. A pasted, appended or duplicated done task that carries a `✅` keeps that date instead of being stamped with today's. Removing `✅` in Edit as Markdown leaves `completed_at` to the task state. The TS writer, the mock and the buffer toolbar follow.

Merged with main after D1 and A3: D1's `+` items and tab stops, A3's addressed anchors and #6032 N6's warning periods all kept. `document-lines.vectors.json` was re-authored by the backend.

Tests changed by decision 4: `export_emits_task_checkbox_and_metadata_property_lines_1916`, `export_descendant_reserved_columns_not_duplicated_2962`, the `apply_page_source_document` and `duplicate_block` fixtures (re-authored), a mock document-lines test, the `obsidian-daily` corpus snapshot, and three e2e-tauri specs (`due-date-agenda`, `agenda-projected-repeat`, `block-duplicate-repeat`) that read dates and rules from the task line.

Known trade: the escape is strict on every surface, so an Obsidian `🛫` kept as text by an import exports as `\🛫`.

Review (sonnet, max) found two defects, fixed with reds shown. First, cycling a task or turning it into another kind in the buffer left its signifiers as literal text, and the save deleted its priority and dates. `retask` now moves them to `key::` lines when no checkbox remains. Second, a lint error in the mock's `taskLineOf`. The mock's apply also keeps a typed done date now. Two new PCTs cover paste warnings and a duplicate keeping its done date. Differential runs found the Rust and TS writers byte-identical, with 0 round-trip defects over a generated corpus.

Left as designed: unticking a done task in the buffer while leaving its `✅` keeps the date as text, with a warning (a vector row pins it); two of the same signifier keep the last.
