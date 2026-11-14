-- #6521: what each transaction added to a space's Loro engine, saved in that
-- transaction.
--
-- `loro_doc_state` holds one whole-space snapshot per space, written by a
-- periodic pass, so a write is in SQL and the op log before it is in the saved
-- engine. A row here is the Loro update one write added to the engine,
-- committed in the write's transaction. A snapshot pass deletes the rows its
-- `loro_doc_state` row covers, in the transaction that writes that row.
--
-- A space's saved engine is its snapshot with these rows imported in `id`
-- order. `id` is AUTOINCREMENT so a deleted id is never handed out again and a
-- pass can name what it covers as "every id up to the one I read".
--
-- No foreign key into `blocks` or `spaces`, as on `loro_doc_state`: an engine
-- can be written before its space block has a row. The purge of a space
-- deletes its rows with its snapshot.
--
-- No index on `space_id`: the table holds what was written since the last
-- pass, and its readers either take every row in `id` order or delete one
-- space's rows during a pass.
--
-- mock-unaffected: the mock has no Loro tables.

CREATE TABLE loro_doc_delta (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    bytes    BLOB NOT NULL
) STRICT;
