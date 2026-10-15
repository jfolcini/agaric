-- #5371: every Pages sort reads its first rows from an index instead of
-- sorting the whole space. The list filters by space, so `pages_cache` carries
-- its page's `blocks.space_id` and each sort gets a `(space_id, key, page_id)`
-- index in the sort's own direction. Last-opened reads the device-local
-- `page_opens` in open order, then the never-opened pages in id order.
--
-- `space_id` mirrors `blocks.space_id` of the page: the page-create INSERT
-- copies it, a `space` op's projection rewrites it in the same transaction,
-- and the page-row rebuild repairs any other drift. No FK, like
-- `page_link_cache.space_id` (0122): it mirrors `blocks.space_id`.
--
-- mock-unaffected: the mock keeps no pages_cache; its list_pages_with_metadata reads each page's own space on every call.

ALTER TABLE pages_cache ADD COLUMN space_id TEXT;

UPDATE pages_cache SET space_id = (
    SELECT b.space_id FROM blocks b WHERE b.id = pages_cache.page_id
);

CREATE INDEX idx_pages_cache_space_title
    ON pages_cache(space_id, title_sort_key, page_id);
CREATE INDEX idx_pages_cache_space_edited
    ON pages_cache(space_id, last_edited_ms DESC, page_id);
CREATE INDEX idx_pages_cache_space_linked
    ON pages_cache(space_id, inbound_link_count DESC, page_id);
CREATE INDEX idx_pages_cache_space_content
    ON pages_cache(space_id, child_block_count DESC, page_id);
CREATE INDEX idx_pages_cache_space_created
    ON pages_cache(space_id, page_id);

CREATE INDEX idx_page_opens_opened ON page_opens(opened_ms, page_id);
