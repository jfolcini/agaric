-- #5841 — built-in property definitions are code constants
-- (`agaric_store::op::BUILTIN_PROPERTY_DEFS`), the same in every vault, so
-- their rows go. A vault whose `todo_state` or `priority` options were
-- customised loses only the customisation: the values blocks hold stay as
-- they are, and only new writes are checked against the fixed options.
--
-- `due` (0011) goes too: it duplicates the built-in `due_date`. Values held
-- under `due` stay, as an undeclared property.
DELETE FROM property_definitions
WHERE key IN (
    'todo_state',
    'priority',
    'due_date',
    'scheduled_date',
    'created_at',
    'completed_at',
    'repeat',
    'repeat-until',
    'repeat-count',
    'repeat-seq',
    'repeat-origin',
    'space',
    'is_space',
    'listStyle',
    'due'
);
