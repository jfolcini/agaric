-- #5371: `pages_cache.last_edited_ms` is at least the newest op on any block
-- of its page. Before `CommandTx::enqueue_without_dispatch`, a page created
-- with its `space` stamp in one command (`create_page_in_space`, a journal
-- day, an import's link target, a bibliography page) kept its create's time,
-- because the commit raised the column only for the ops it dispatched. A page
-- with no later op stays below that floor, which Settings › App health reports
-- as a divergence. Raise every row to the floor; the column only ever rises.
-- A row still at 0123's unfilled 0 is left alone: boot schedules the page-row
-- rebuild for it, which fills its title key as well.
--
-- mock-unaffected: the mock keeps no pages_cache.

UPDATE pages_cache
SET last_edited_ms = newest.created_ms
FROM (
    SELECT
        d.page_id,
        MAX(o.created_at) AS created_ms
    FROM blocks AS d
    INNER JOIN op_log AS o ON d.id = o.block_id
    WHERE d.page_id IS NOT NULL
    GROUP BY d.page_id
) AS newest
WHERE
    pages_cache.page_id = newest.page_id
    AND pages_cache.last_edited_ms > 0
    AND newest.created_ms > pages_cache.last_edited_ms;
