-- #3370 — database-level enforcement of the `attachments.fs_path` shape.
--
-- mock-unaffected: adds two BEFORE-write CHECK triggers on `attachments`.
-- No column, index or default changes, so the shape the browser/e2e Tauri
-- mock models is untouched. The mock never persists attachment bytes (its
-- add_attachment handler mints an in-memory row) and therefore has no
-- `fs_path` semantics to keep in lockstep.
--
-- `fs_path` is the on-disk location of an attachment's bytes, relative to
-- `app_data_dir`. Two properties have to hold for every row, and both were
-- until now the responsibility of whichever code happened to be doing the
-- INSERT:
--
--  1. **Confinement.** `app_data_dir` also holds `notes.db`, its WAL, and the
--     app's other state. A `fs_path` outside `attachments/` names one of them,
--     and the sync file-receive path writes a peer's bytes at whatever the row
--     says. Nothing but the `attachments/` prefix separates an attachment path
--     from a write primitive over the database.
--
--  2. **Canonical spelling.** The orphan GC decides what to unlink by testing
--     its directory-walk path string for membership in the set of stored
--     `fs_path` strings. `attachments/./x.png` and `attachments/x.png` name one
--     file but are two strings; the row spelled the first way misses the set
--     and the GC destroys bytes that a live row references.
--
-- `agaric_core::attachment_path::AttachmentFsPath` is where those rules are
-- defined, and every writer now parses through it. These triggers are the
-- backstop for the writer that does not: a future INSERT that binds a raw
-- peer string fails loudly here instead of silently seeding a row that the
-- resolvers refuse to read and the GC mistakes for garbage.
--
-- Scope and limits
-- ----------------
-- SQLite cannot canonicalize a path, so this expresses the *lexical* residue of
-- the Rust rule: rooted at `attachments/`, forward slashes only, no empty /
-- `.` / `..` component, no trailing separator, no drive or stream separator.
-- A value that passes here is not thereby canonical in every sense the Rust
-- parser means (it cannot check control characters or Windows trailing-dot
-- folding), so this does not replace the parse — it catches the writer that
-- skipped it. Everything the Rust parser accepts passes these triggers, which
-- is the direction that matters: the backstop must never refuse a value the
-- canonicalizer just produced.
--
-- `GLOB` is used rather than `LIKE` throughout because `LIKE` is
-- case-insensitive for ASCII in SQLite by default, which would let
-- `Attachments/x.png` through — a different directory on any case-sensitive
-- filesystem.
--
-- Existing rows are untouched: a trigger fires on write, not on rows at rest,
-- and the read paths deliberately stay tolerant of what is already stored.

CREATE TRIGGER IF NOT EXISTS attachments_fs_path_shape_insert
BEFORE INSERT ON attachments
WHEN NEW.fs_path NOT GLOB 'attachments/?*'
     OR instr(NEW.fs_path, char(92)) > 0
     OR instr(NEW.fs_path, ':') > 0
     OR instr(NEW.fs_path, '//') > 0
     OR instr(NEW.fs_path, '/./') > 0
     OR instr(NEW.fs_path, '/../') > 0
     OR NEW.fs_path GLOB '*/.'
     OR NEW.fs_path GLOB '*/..'
     OR NEW.fs_path GLOB '*/'
BEGIN
    SELECT RAISE(
        ABORT,
        'attachments.fs_path must be a canonical path under attachments/ (#3370)'
    );
END;

CREATE TRIGGER IF NOT EXISTS attachments_fs_path_shape_update
BEFORE UPDATE OF fs_path ON attachments
WHEN NEW.fs_path NOT GLOB 'attachments/?*'
     OR instr(NEW.fs_path, char(92)) > 0
     OR instr(NEW.fs_path, ':') > 0
     OR instr(NEW.fs_path, '//') > 0
     OR instr(NEW.fs_path, '/./') > 0
     OR instr(NEW.fs_path, '/../') > 0
     OR NEW.fs_path GLOB '*/.'
     OR NEW.fs_path GLOB '*/..'
     OR NEW.fs_path GLOB '*/'
BEGIN
    SELECT RAISE(
        ABORT,
        'attachments.fs_path must be a canonical path under attachments/ (#3370)'
    );
END;
