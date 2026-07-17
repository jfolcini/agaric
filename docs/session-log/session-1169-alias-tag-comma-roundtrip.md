# Session 1169 — Alias/tag values with embedded commas round-trip (#2829)

## Scope

Export quotes flow-significant frontmatter values (`yaml_flow_item("Beta, Inc")`
→ `"Beta, Inc"`), and `parse_flow_sequence` is quote-aware — but it then JOINED
the parsed items back into a single comma-separated scalar. The #2722 import
interception in `commands/pages/markdown.rs` re-split that scalar on every literal
comma (`value.split(',')`), so an alias or tag whose value contains a literal
comma was wrongly split into two. Not a regression (pre-#2722 these were inert
text properties), but the quote-aware parse was wasted. Surfaced during the #2722
review.

## Change

- `agaric-engine/src/import.rs` — renamed `parse_flow_sequence(&str) -> String` to
  `parse_flow_sequence_items(&str) -> Vec<String>` (returns the unjoined items;
  callers wanting the legacy scalar `.join(", ")` themselves). Added
  `pub frontmatter_list_items: HashMap<String, Vec<String>>` to `ParseOutput`,
  populated for any frontmatter key that arrived as a genuine YAML sequence
  (inline flow `[a, b]` AND block-style `- a`), alongside the unchanged
  comma-joined `frontmatter` scalar. Threaded through
  `parse_logseq_markdown` → `strip_frontmatter` → `parse_frontmatter`.
- `commands/pages/markdown.rs` — the aliases and tags interception now prefer
  `parse_output.frontmatter_list_items.get(key)` (exact parsed boundaries),
  falling back to `value.split(',')` only for a plain unbracketed scalar
  (`aliases: a, b`), which carries no boundary info and is out of scope. No other
  frontmatter keys are affected.

## Tests

`import_markdown_alias_and_tag_with_embedded_comma_not_split_2829`: frontmatter
`aliases: ["Beta, Inc", Gamma]` / `tags: ["billing, invoices", urgent]` imports to
exactly 2 aliases and 2 tags (comma-bearing item kept whole, second plain item
proving ordinary multi-item splitting still works). Fails pre-fix (3 aliases).
The two #1917 flow/block-sequence tests gained `list_items` assertions pinning the
new contract.

## Review

Independent consolidation + adversarial review: all three cases verified (embedded
comma → 1 item; plain scalar still splits via fallback; block sequence populates
list_items); `if !items.is_empty()` guard leaves `tags: []` out (no regression);
purely additive `frontmatter_list_items`, no collateral change to other keys. Full
suite 3462 passed / 0 failed / 6 skipped (1 pre-existing timing flake, passed on
retry); clippy `-D warnings` clean; no `.sqlx` delta.

Closes #2829.
