# Session 1179 — import/export round-trip fidelity (#2715, #2716, #2725)

## Scope

Three deep-review data-fidelity bugs where exported markdown did not re-import to
the same blocks. All three live at the import/export boundary
(`agaric-engine::import` + `commands::pages::markdown`).

Closes #2715, #2716, #2725.

## Fixes

- **#2715 (HIGH) — frontmatter scalars not YAML-escaped.** `export_page_markdown_inner`
  emitted `key: value` verbatim, so an embedded newline / leading `---` / `: ` could
  inject keys or break out of the frontmatter fence. New `yaml_scalar_emit` in
  `markdown_yaml.rs`: newline-bearing values become a YAML literal block scalar
  (`key: |` + indented lines, which `parse_frontmatter` re-joins with `\n`);
  single-line ambiguous values are verbatim double-quoted — the exact inverse of
  `strip_yaml_quotes`, which strips the outer pair and decodes nothing. Plain values
  are unchanged.

- **#2716 (HIGH) — multi-line block content didn't round-trip.** Block content was
  written verbatim after the bullet, so embedded newlines landed continuation lines at
  column 0 and re-parsed as new blocks/properties. `push_block_bullet` now indents
  continuation lines under the bullet (never re-prefixed with `- `), and a continuation
  line that would re-parse as a bullet or `key:: value` property is backslash-escaped on
  export; the importer un-escapes it (matched against the *trimmed* line shape) only when
  the payload really is a bullet/property, so legit leading-`\` content (LaTeX) survives.

- **#2725 (medium) — fenced code with list/property lines split on import.**
  `parse_logseq_markdown` spawned a new block for `- `-prefixed lines inside a code
  fence. Guarded both bullet branches with `in_code_body = in_fence && !is_fence_delim`
  (which still treats the fence's own opening/closing delimiters as the owning block's
  lines), plus a `fence_split_avoided_count` warning counter.

## Tests

- Unit: `yaml_scalar_emit_shapes_2715`, `content_line_is_ambiguous_2716`
  (`markdown_yaml.rs`); `parse_fenced_code_with_list_and_property_lines_stays_one_block_2725`
  (`import.rs`).
- Full DB round-trip (`page_cmd_tests.rs`), asserting byte-identity + structural
  invariants (exactly one frontmatter fence pair; exactly one content block):
  `import_export_frontmatter_scalar_escaping_round_trip_2715`,
  `import_export_multiline_block_content_round_trip_2716`,
  `import_export_fenced_code_block_round_trip_2725`.

## Review

Adversarial review (independent, re-derived the round-trip invariant from
`strip_yaml_quotes`/`parse_frontmatter`/`parse_logseq_markdown`) caught and fixed a real
content-corruption bug: an *indented* ambiguous continuation line (`intro\n  - sub`)
leaked a spurious `\` because the importer's un-escape predicate tested the *untrimmed*
line; fixed to match the trimmed shape, with regression test
`parse_unescapes_indented_ambiguous_continuation_2716`. All other adversarial cases
(already-quoted values, lone quotes, block-scalar indicators, bare fences, EOF-inside-fence,
the three-fix interaction) round-trip byte-for-byte. Final: 165 targeted tests green,
`cargo fmt --check` clean.

## Follow-up

- **#2866** — an *unbalanced* code fence in block content leaves the importer's
  document-global `in_fence` open and swallows the next sibling block. Malformed-input-only
  (the editor always emits balanced fences); a correct fix needs an importer fence-state
  redesign, out of scope for this surgical PR.

## Known limitations (parser-inherent, pre-existing)

- A frontmatter multi-line value whose first line begins with whitespace over-strips
  (block-scalar auto-indent detection).
- Interior double-spaces / leading-trailing whitespace / blank lines in block content are
  trimmed/dropped by the importer's long-standing line normalization.
