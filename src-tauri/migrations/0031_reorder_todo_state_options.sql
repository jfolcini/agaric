-- UX-234: Reorder locked todo_state cycle so CANCELLED is the terminal
-- "abandoned" state and sits AFTER DONE in the option list.
--
-- The cycle is locked (UX-201a) — there is no user customization to
-- preserve, so this UPDATE is idempotent and safe.
UPDATE property_definitions
SET options = '["TODO","DOING","DONE","CANCELLED"]'
WHERE key = 'todo_state';
