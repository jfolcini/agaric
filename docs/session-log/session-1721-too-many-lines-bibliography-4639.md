# Session 1721 — the `bibliography.rs` parser splits (#4639)

Refs #4639, fourth slice: the three `#[expect(clippy::too_many_lines)]`
sites in `agaric-engine/src/bibliography.rs`, the BibTeX and CSL-JSON
parsers (`parse_value_part`, `parse_bibtex`, `parse_csl_json`). Pure
moves; warning text, entry and warning order, field normalisation and
every fallback are untouched, and the existing parser tests are the
oracle.

- `parse_value_part` (94 lines): one helper per non-bare arm,
  `parse_braced_value` (nesting-aware, one outer layer stripped) and
  `parse_quoted_value` (brace-depth-aware quote termination). The two loops
  differ in depth semantics and error text, so they are not shared.
- `parse_bibtex` (185): `parse_entry_header` resolves the entry type and
  citation key, returning `None` where the original loop `continue`d with
  its warning pushed; `parse_field_value` reads one `part # part` value;
  `scan_entry_fields` runs the field loop and hands back the ignored-field
  list and the LaTeX-kept flag so the parent emits the two once-per-entry
  warnings in the original order. A dead `aborted` flag whose only reader
  was an empty block went; its comment now sits on the `break` it
  explained.
- `parse_csl_json` (126): `push_csl_authors` renders the author objects
  with their three per-author warnings, and `csl_entry` maps one object
  (id, type with the `misc` fallback, the trimmed scalars, authors, the
  issued year); the not-an-object check stays before it and the
  ignored-keys warning after it, so per-entry warning order is unchanged.
No lint suppression was added; the widest helper has seven arguments.

## Verified

`cargo clippy -p agaric-engine --lib --tests -- -D warnings` prints
nothing with the three attributes gone; `SQLX_OFFLINE=true cargo check
--workspace --all-targets` 0 warnings; `cargo nextest run --workspace` 6318
passed, 13 skipped; doc-tests green. The reviewer mapped every exit of
the old `parse_bibtex` loops onto the new helpers one to one (five outer,
seven inner) and confirmed all fourteen warning strings, both
`unbalanced_error` sites and both validation messages are byte-identical
and emitted in the same order. Falsified on copies: a nested-brace push
dropped reddened `bibtex_parses_all_mapped_fields`; the duplicate-field
warning dropped reddened `bibtex_duplicate_field_keeps_first_and_warns`;
the `container-title` mapping dropped reddened
`csl_json_parses_mapped_fields`; the reviewer independently dropped the
missing-key warning and reddened
`bibtex_missing_citation_key_skips_entry_with_warning`. All restored,
`cmp` clean. Attribute count 107 to 104.
