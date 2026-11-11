/**
 * The integrity report in plain words (#6488).
 *
 * The backend names each divergence by its internal artefact,
 * `table.column`. This module sorts those into the two kinds the user acts on
 * differently, and names each table and its problem through i18n keys:
 *
 * - **rebuildable** — every artefact outside `engine.*`: a cache the app
 *   derives from the notes, which a rebuild rewrites and loses nothing by;
 * - **engine** — `engine.*`: the database and the sync engine hold different
 *   rows, which no rebuild repairs;
 * - **ids** — `blocks.id_form`: blocks stored under an id `BlockId` would
 *   rewrite, which bulk Trash actions skip and only a decided repair changes.
 *
 * An artefact this module does not know keeps its internal name as its label,
 * so a new oracle artefact still reads, just not in plain words.
 */

import type { ArtefactDivergences, ReconciliationReport } from '@/lib/bindings'

export type IntegrityKind = 'rebuildable' | 'engine' | 'ids'

export interface IntegrityGroup {
  kind: IntegrityKind
  artefacts: ArtefactDivergences[]
  /** Sum of `count` over `artefacts`. */
  rows: number
}

const ENGINE_PREFIX = 'engine.'
const ID_FORM = 'blocks.id_form'

/** The table segment of each artefact, keyed to its `integrity.table.*` id. */
const TABLE_IDS: Readonly<Record<string, string>> = {
  fts_blocks: 'search',
  pages_cache: 'pages',
  page_link_cache: 'pageLinks',
  block_links: 'blockLinks',
  block_links_unresolved: 'unresolvedLinks',
  block_tag_refs: 'inlineTags',
  block_tag_inherited: 'inheritedTags',
  tags_cache: 'tags',
  agenda_cache: 'agenda',
  projected_agenda_cache: 'projectedAgenda',
  attachment_blobs: 'attachmentFiles',
  blocks: 'blockPlacement',
  spaces: 'spaces',
}

/** The table segment of an `engine.*` artefact, keyed the same way. */
const ENGINE_TABLE_IDS: Readonly<Record<string, string>> = {
  blocks: 'blocks',
  attachments: 'attachments',
  block_tags: 'blockTags',
  page_aliases: 'pageAliases',
  block_properties: 'properties',
  property_definitions: 'propertyDefinitions',
}

/** The `integrity.*` keys that title, explain and say what to do about each
 *  kind's group. */
export const GROUP_KEYS: Readonly<
  Record<IntegrityKind, { title: string; detail: string; action: string }>
> = {
  rebuildable: {
    title: 'integrity.groupRebuildableTitle',
    detail: 'integrity.groupRebuildableDetail',
    action: 'integrity.groupRebuildableAction',
  },
  engine: {
    title: 'integrity.groupEngineTitle',
    detail: 'integrity.groupEngineDetail',
    action: 'integrity.groupEngineAction',
  },
  ids: {
    title: 'integrity.groupIdsTitle',
    detail: 'integrity.groupIdsDetail',
    action: 'integrity.groupIdsAction',
  },
}

export function divergenceKind(artefact: string): IntegrityKind {
  if (artefact === ID_FORM) return 'ids'
  return artefact.startsWith(ENGINE_PREFIX) ? 'engine' : 'rebuildable'
}

/** `[table, column]` of an artefact, the engine prefix dropped. */
function segments(artefact: string): [string, string] {
  const bare = artefact.startsWith(ENGINE_PREFIX) ? artefact.slice(ENGINE_PREFIX.length) : artefact
  const dot = bare.indexOf('.')
  return dot === -1 ? [bare, ''] : [bare.slice(0, dot), bare.slice(dot + 1)]
}

/** The table's id under `integrity.table.*`, or `null` for one this module
 *  does not know. */
export function tableId(artefact: string): string | null {
  if (artefact === ID_FORM) return 'blocks'
  const [table] = segments(artefact)
  const ids = divergenceKind(artefact) === 'engine' ? ENGINE_TABLE_IDS : TABLE_IDS
  return ids[table] ?? null
}

/** The problem's id under `integrity.problem.*`. */
export function problemId(artefact: string): string {
  const [table, column] = segments(artefact)
  if (artefact === ID_FORM) return 'idForm'
  if (divergenceKind(artefact) === 'engine') return column === 'row' ? 'engineRows' : 'engineValues'
  if (table === 'fts_blocks' && column === 'stripped') return 'olderStrip'
  if (column === 'duplicate_row') return 'duplicate'
  if (column === 'row' || column === 'edge') return 'rows'
  if (column.endsWith('_count') || column === 'refcount') return 'counts'
  if (column === 'title_sort_key') return 'sortKey'
  return 'values'
}

/** The report's artefacts by kind, rebuildable first, then the engine, then
 *  ids; a kind with no rows is absent. Order within a kind is the backend's,
 *  root cause first. */
export function groupByKind(report: ReconciliationReport): IntegrityGroup[] {
  const groups: IntegrityGroup[] = []
  for (const kind of ['rebuildable', 'engine', 'ids'] as const) {
    const artefacts = report.artefacts.filter((a) => divergenceKind(a.artefact) === kind)
    if (artefacts.length === 0) continue
    groups.push({ kind, artefacts, rows: artefacts.reduce((sum, a) => sum + a.count, 0) })
  }
  return groups
}
