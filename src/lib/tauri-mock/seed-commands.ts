/**
 * #6529 — the mock's seed as the commands that write it.
 *
 * A Playwright worker on the real backend sends these to its bridge once, so
 * the vault every test starts from holds what `seedBlocks` holds, under the
 * same `SEED_IDS`, written by the app's own commands.
 *
 * Not reproduced: the seed's backdated `op_log` rows (a command stamps "now"),
 * and the opt-in fixtures `seedBlocks` reads from `localStorage`.
 */

import {
  blocks,
  blockTags,
  DEFAULT_PROPERTY_DEFS,
  pageAliases,
  properties,
  seedBlocks,
  spacePropertyDefs,
} from '@/lib/tauri-mock/seed'

interface SeedCommand {
  cmd: string
  args: Record<string, unknown>
}

/** The mock's id for the space the seed lives in. */
const MOCK_SPACE = 'SPACE_PERSONAL'

/** A page or tag first, so a block's `[[id]]` and `#[id]` tokens resolve as it is created. */
const CREATE_ORDER = ['page', 'tag']

/** The block's fields a command of their own sets, with the argument naming the value. */
const FIELD_COMMANDS = [
  ['todo_state', 'set_todo_state', 'state'],
  ['priority', 'set_priority', 'level'],
  ['due_date', 'set_due_date', 'date'],
  ['scheduled_date', 'set_scheduled_date', 'date'],
] as const

const VALUE_COLUMNS = ['value_text', 'value_num', 'value_date', 'value_ref', 'value_bool'] as const

/**
 * The commands that write the seed into `spaceId`, a space holding nothing but
 * its default property definitions.
 */
export function seedCommands(spaceId: string): SeedCommand[] {
  seedBlocks()
  const commands: SeedCommand[] = []
  const defaults = new Set(DEFAULT_PROPERTY_DEFS.map(([key]) => key))
  for (const def of spacePropertyDefs(MOCK_SPACE).values()) {
    if (defaults.has(def['key'] as string)) continue
    commands.push({
      cmd: 'create_property_def',
      args: { spaceId, key: def['key'], valueType: def['value_type'], options: def['options'] },
    })
  }

  const seeded = [...blocks.values()]
    .filter((block) => !properties.get(block['id'] as string)?.has('is_space'))
    .toSorted((a, b) => createRank(a) - createRank(b))
  for (const block of seeded) {
    commands.push({
      cmd: 'create_block',
      args: {
        blockType: block['block_type'],
        content: block['content'],
        parentId: block['parent_id'],
        index: null,
        scope: { kind: 'active', space_id: spaceId },
        blockId: block['id'],
      },
    })
  }
  for (const block of seeded) {
    const blockId = block['id'] as string
    for (const [field, cmd, arg] of FIELD_COMMANDS) {
      if (block[field] != null) commands.push({ cmd, args: { blockId, [arg]: block[field] } })
    }
    for (const row of properties.get(blockId)?.values() ?? []) {
      // `set_todo_state` stamps it on a DONE block.
      if (row['key'] === 'completed_at') continue
      const value = Object.fromEntries(VALUE_COLUMNS.map((column) => [column, row[column] ?? null]))
      commands.push({ cmd: 'set_property', args: { blockId, key: row['key'], value } })
    }
    for (const tagId of blockTags.get(blockId) ?? []) {
      commands.push({ cmd: 'add_tag', args: { blockId, tagId } })
    }
    const aliases = pageAliases.get(blockId)
    if (aliases) commands.push({ cmd: 'set_page_aliases', args: { pageId: blockId, aliases } })
  }
  return commands
}

function createRank(block: Record<string, unknown>): number {
  const rank = CREATE_ORDER.indexOf(block['block_type'] as string)
  return rank === -1 ? CREATE_ORDER.length : rank
}
