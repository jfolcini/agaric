-- Enforce valid block_type values via BEFORE INSERT / BEFORE UPDATE triggers.
-- SQLite does not support ALTER TABLE ADD CHECK, so triggers are used instead.

CREATE TRIGGER IF NOT EXISTS check_block_type_insert
BEFORE INSERT ON blocks
BEGIN
    SELECT RAISE(ABORT, 'invalid block_type: must be content, tag, or page')
    WHERE NEW.block_type NOT IN ('content', 'tag', 'page');
END;

CREATE TRIGGER IF NOT EXISTS check_block_type_update
BEFORE UPDATE OF block_type ON blocks
BEGIN
    SELECT RAISE(ABORT, 'invalid block_type: must be content, tag, or page')
    WHERE NEW.block_type NOT IN ('content', 'tag', 'page');
END;
