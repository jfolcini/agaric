-- #4551. `block_links` merged two things the editor draws differently:
-- `[[ULID]]` page links and `((ULID))` block references. The kind is a pure
-- function of the token already in `blocks.content`, so it is derived for
-- every existing row rather than defaulted.
--
-- ADD COLUMN, not a `_new_block_links` rebuild: the primary key is unchanged
-- (a pair stays one row), so the table's shape needs no restating and the
-- two-column `INSERT INTO block_links (source_id, target_id)` in benches and
-- tests keeps meaning what it meant. The trade is the DEFAULT: an INSERT that
-- forgets `kind` lands `page_link` silently. Every production INSERT is in
-- `agaric-store/src/cache/block_links.rs` and names `kind`;
-- `reindex_block_links_writes_kind_and_updates_on_change_4551` pins it.
ALTER TABLE block_links
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'page_link'
        CHECK (kind IN ('page_link', 'block_ref'));

-- Classification rule, identical in SQL, Rust (`classify_link_kind`) and the
-- JS mock (`classifyLinkKind`): a pair is a `block_ref` iff the source content
-- carries the exact `((<target>))` token. `ULID_LINK_RE` tolerates mixed
-- delimiters (`[[X))`), so those classify `page_link` under all three — one
-- rule, no residue arm. `block_ref` wins a pair carrying BOTH forms: the key
-- holds one row, and the quotation is the claim the user filters for.
UPDATE block_links
   SET kind = 'block_ref'
 WHERE EXISTS (
     SELECT 1 FROM blocks b
      WHERE b.id = block_links.source_id
        AND instr(b.content, '((' || block_links.target_id || '))') > 0
 );

-- No index change: `idx_block_links_target_source(target_id, source_id)`
-- (0083) still positions the backlink seek, and widening it to include `kind`
-- would break the `ORDER BY` the composite exists to supply.
