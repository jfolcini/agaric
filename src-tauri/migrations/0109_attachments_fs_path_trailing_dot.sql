-- #3370 review — tighten 0108's `attachments.fs_path` shape triggers so a
-- component ending in a dot or a space is refused.
--
-- mock-unaffected: replaces two BEFORE-write CHECK triggers on `attachments`.
-- No column, index or default changes, so the shape the browser/e2e Tauri mock
-- models is untouched, and the mock has no `fs_path` semantics to mirror.
--
-- Why this was missed in 0108
-- ---------------------------
-- 0108 refused a component that was *entirely* dots/spaces (`GLOB '*/.'`,
-- `'*/..'`), which is the `..`-revival case. It did not refuse a component that
-- merely ENDS in one. Windows strips trailing dots and spaces from a path
-- component at create time, so a row spelled `attachments/photo.png.` has its
-- bytes land at `attachments\photo.png`. The orphan GC then derives
-- `attachments/photo.png` from its directory walk, misses the stored string,
-- and destroys bytes that a live row references — failure mode 2 of #3370,
-- reached by a spelling the first pass let through.
--
-- `AttachmentFsPath::parse` now folds those characters away per component, so
-- no writer produces such a value any more. These triggers are the backstop for
-- the writer that skips the parse, and they have to refuse what the parse would
-- have folded, or the backstop's notion of canonical is looser than the
-- canonicalizer's.
--
-- Triggers are replaceable objects, not table state: DROP + CREATE is the only
-- way to change one, and it rewrites no rows. Migrations stay append-only —
-- 0108 is untouched and still shipped verbatim.
--
-- `GLOB` rather than `LIKE` throughout, because SQLite's `LIKE` is
-- case-insensitive for ASCII and would admit `Attachments/photo.png` — a
-- different directory on any case-sensitive filesystem.
--
-- Existing rows are untouched: a trigger fires on write, not on rows at rest.

DROP TRIGGER IF EXISTS attachments_fs_path_shape_insert;
DROP TRIGGER IF EXISTS attachments_fs_path_shape_update;

CREATE TRIGGER attachments_fs_path_shape_insert
BEFORE INSERT ON attachments
WHEN NEW.fs_path NOT GLOB 'attachments/?*'
     OR instr(NEW.fs_path, char(92)) > 0
     OR instr(NEW.fs_path, ':') > 0
     OR instr(NEW.fs_path, '//') > 0
     OR instr(NEW.fs_path, '/./') > 0
     OR instr(NEW.fs_path, '/../') > 0
     -- A component ending in a dot or a space: either just before a separator,
     -- or at the very end of the path.
     OR instr(NEW.fs_path, './') > 0
     OR instr(NEW.fs_path, ' /') > 0
     OR NEW.fs_path GLOB '*[. ]'
     OR NEW.fs_path GLOB '*/'
BEGIN
    SELECT RAISE(
        ABORT,
        'attachments.fs_path must be a canonical path under attachments/ (#3370)'
    );
END;

CREATE TRIGGER attachments_fs_path_shape_update
BEFORE UPDATE OF fs_path ON attachments
WHEN NEW.fs_path NOT GLOB 'attachments/?*'
     OR instr(NEW.fs_path, char(92)) > 0
     OR instr(NEW.fs_path, ':') > 0
     OR instr(NEW.fs_path, '//') > 0
     OR instr(NEW.fs_path, '/./') > 0
     OR instr(NEW.fs_path, '/../') > 0
     OR instr(NEW.fs_path, './') > 0
     OR instr(NEW.fs_path, ' /') > 0
     OR NEW.fs_path GLOB '*[. ]'
     OR NEW.fs_path GLOB '*/'
BEGIN
    SELECT RAISE(
        ABORT,
        'attachments.fs_path must be a canonical path under attachments/ (#3370)'
    );
END;
