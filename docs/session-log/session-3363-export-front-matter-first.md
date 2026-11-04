# Session 3363 — the export writes front matter first, and property values survive it

#6277 A1 and A2.

A1: the export and the agent read wrote `# Title` and then the YAML front matter. Obsidian reads properties only at byte 0, so it showed none of them. GitHub drew the first `---` as a rule and the last YAML line as a setext heading. Both renderers now share `render_page_head`, which writes the front matter at byte 0 and then the title. On import, `strip_title_heading` also finds the title line right after a leading front matter, so the new shape re-imports with no heading block. The older title-first shape still imports through `strip_frontmatter` case 2. The mock's `import_markdown` copies the title strip and got the same change.

A2: Export and Agent wrote a block-property value raw. A multi-line `notes::` value kept only its first line on re-import, and each later line became a new block. `render_block` now writes every value through `write_source_property_value` in every mode, and `Scan::attach_property` reads it back with `read_source_property_value` under every parse mode. One behaviour change on import: a Logseq file's `key:: "text"` now stores `text`, unquoted. `a_property_value_reads_back_as_it_was_written`, which pinned the old reading, changed with the decision.

Reds: `export_writes_front_matter_first_and_reimports_without_a_heading_6277` (title first before the fix); the proptest `a_property_value_survives_the_export_and_the_agent_read`, which covers Export → `parse_logseq_markdown` and Agent → `parse_pasted_text` (a `\t` value was swallowed); and a mock vitest. Each arm was falsified on its own, Agent quoting included.

Ran: nextest over the export, import, markdown, front, property, agent, conformance, summarise, tool_descriptions and title filters (1540 of 1540); clippy; `SQLX_OFFLINE=true cargo check --workspace --all-targets`; vitest over the mock; typecheck.
