/**
 * #6529 — `seedCommands`: sent to a vault holding only its space, the commands
 * leave what `seedBlocks` leaves. The vault here is the mock's own, emptied.
 */

import { expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  blockTags,
  DEFAULT_PROPERTY_DEFS,
  pageAliases,
  properties,
  spacePropertyDefs,
} from '@/lib/tauri-mock/seed'
import { seedCommands } from '@/lib/tauri-mock/seed-commands'

const SPACE = 'SPACE_PERSONAL'
const BLOCK_FIELDS = [
  'block_type',
  'content',
  'parent_id',
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
  'space_id',
]
const VALUE_COLUMNS = ['value_text', 'value_num', 'value_date', 'value_ref', 'value_bool']

function pick(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))
}

/** Everything the seed holds, without the positions and stamps a create assigns. */
function vault(): unknown {
  return {
    blocks: Object.fromEntries([...blocks].map(([id, row]) => [id, pick(row, BLOCK_FIELDS)])),
    properties: Object.fromEntries(
      [...properties]
        .map(([id, rows]) => [
          id,
          Object.fromEntries(
            [...rows]
              // `set_todo_state` stamps a task's `created_at`; the seed's tasks have none.
              .filter(([key]) => key !== 'created_at')
              .map(([key, row]) => [key, pick(row, VALUE_COLUMNS)]),
          ),
        ])
        .filter(([, rows]) => Object.keys(rows as object).length > 0),
    ),
    tags: Object.fromEntries([...blockTags].map(([id, tags]) => [id, new Set(tags)])),
    aliases: Object.fromEntries(pageAliases),
    definitions: Object.fromEntries(
      [...spacePropertyDefs(SPACE)].map(([key, def]) => [
        key,
        pick(def, ['value_type', 'options']),
      ]),
    ),
  }
}

it('the commands rebuild the seed in a vault that holds only its space', () => {
  const commands = seedCommands(SPACE)
  const seeded = vault()

  for (const id of blocks.keys()) {
    if (id === SPACE) continue
    blocks.delete(id)
    properties.delete(id)
  }
  blockTags.clear()
  pageAliases.clear()
  const defaults = new Set(DEFAULT_PROPERTY_DEFS.map(([key]) => key))
  const definitions = spacePropertyDefs(SPACE)
  for (const key of definitions.keys()) if (!defaults.has(key)) definitions.delete(key)
  expect(blocks.size).toBe(1)

  for (const { cmd, args } of commands) dispatch(cmd, args)
  expect(vault()).toEqual(seeded)
})
