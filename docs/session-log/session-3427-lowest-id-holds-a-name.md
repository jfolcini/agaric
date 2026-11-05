# Session 3427 — The lowest id holds a shared page name (#6278 I2)

Item I2 of #6278, stacked on I1 (#6318). A name two live pages of a space share, under I1's `name_key`, resolves to the lower id on every inbound path instead of staying text: import, paste, the Edit as Markdown save and its Preview, ref-typed property values, MCP name arguments and `resolve`, the `[[` input rule, and the mock.

- `LinkMatches` holds one id per key, and `push` keeps the lowest whatever the row order. `LinkMatch`, `NameMatch`, `first_rule_ids`, `MAX_NAME_CANDIDATES` and `warn_ambiguous_link` are gone, and with them MCP `resolve`'s tie error and `page_candidates`.
- The title step no longer prefers an exact spelling over the fold. Review found that exact-first made a paste of `[[Foo]]` link a newer `Foo` while a create of `Foo` returned an older `foo`; under the decision a folded tie is a tie, so the rule is now: title by `name_key` (lowest id), then alias. A render writes `[[Title]]` for the holder and a raw `[[ULID]]` for a twin, since its title reads back to the holder.
- The mock's `create_block` for a page now applies I1's name check, as the backend does through `create_page_in_space_inner`, and the e2e spec builds its tie through `import_markdown` instead.
- Existing tests that pinned a refused tie or exact-first were flipped to the holder. A deleted tie leg was restored as a positive, and seeds where the exact spelling was also the lowest id (so they could not catch exact-first) were reseeded.
- Left alone: `ORDER BY id` in the snapshot queries is now redundant but moving it would churn the four `.sqlx` caches for no behaviour change.

Suites run: full `cargo nextest run --workspace`, `conformance_fuzz`, clippy, `SQLX_OFFLINE` check, vitest over every changed area, typecheck, lint, `prek` (all and manual), Playwright on the new spec and 15 related link, paste, page-source, import, picker and alias specs.
