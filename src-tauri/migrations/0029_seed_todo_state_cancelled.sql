-- UX-202: Lock the TODO state cycle and seed CANCELLED.
--
-- The task_cycle is now fixed at null → TODO → DOING → CANCELLED → DONE → null.
-- Update the seeded `todo_state` property_definition so picker/filter UIs show
-- all four states, including the newly added CANCELLED.
UPDATE property_definitions
SET options = '["TODO","DOING","CANCELLED","DONE"]'
WHERE key = 'todo_state';
