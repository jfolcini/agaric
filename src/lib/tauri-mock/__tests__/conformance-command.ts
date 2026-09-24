/**
 * #4670 — the MUTATING-command leg of the #763 conformance harness (TS /
 * tauri-mock side). Twin of
 * `src-tauri/tests/command_integration/conformance_command.rs`, which carries
 * the rationale.
 *
 * A fixture op carrying `"via": "command"` is replayed through the mock's
 * handler like any other, but its RETURN VALUE — or its refusal, the
 * `AppErrorKind` plus the `ValidationCode` — is projected into the same row
 * tokens the Rust runner recorded in the fixture's `expected_ops`. `op_refs` is
 * never read (the two stacks' device ids differ); a list-valued field becomes
 * one `<field>-><id>` token per element.
 *
 * Keep {@link RETURN_SHAPE} in lockstep with the Rust `RETURN_SHAPE`, exactly
 * as `WIRE` in `conformance-query.ts` mirrors `run_step`.
 */

import { PROPERTY_DEF_ATTRS, idToken } from '@/lib/tauri-mock/__tests__/conformance-query'
import { dispatch } from '@/lib/tauri-mock/handlers'

export interface CommandOpStep {
  command: string
  args: Record<string, unknown>
  /** Opt this op into the command leg. The only value is `"command"`. */
  via?: 'command'
  /** Required with `via`; unique within the fixture. */
  name?: string
  /** The `AppErrorKind` wire string the command is expected to refuse with. */
  expect_error?: string
  /** The `ValidationCode` the refusal carries; `expect_error: "validation"` only. */
  expect_code?: string
  comment?: string
}

export interface CommandRecord {
  name: string
  returns: string[]
  error: string | null
  code: string | null
}

interface ReturnShape {
  idKey: string
  attrs: readonly string[]
  lists: readonly string[]
  /**
   * #5140 — the key the LIST OF ROWS rides under when the wrapper answers
   * `WithOps<{ [rows]: T[] }>` (a `Vec` cannot be flattened). The Rust runner
   * calls the `_inner`, which returns the bare list, so this is TS-only: it
   * strips the envelope the mock mirrors, as ignoring `op_refs` does.
   */
  rows?: string
}

/**
 * `idKey` for a response carrying no row identity of its own — a unit return,
 * or an envelope that is only a count. The token head is the COMMAND NAME and
 * each `attrs` entry is read off the response, mirroring the query leg's
 * `headed` token kind. MUST match `HEADED_ID_KEY` in the Rust twin.
 */
const HEADED_ID_KEY = '<headed>'

/** MUST match `RETURN_SHAPE` in the Rust twin. */
const RETURN_SHAPE: Readonly<Record<string, ReturnShape>> = {
  delete_block: {
    idKey: 'block_id',
    attrs: ['deleted_at', 'descendants_affected'],
    lists: ['affected_page_ids'],
  },
  purge_block: { idKey: 'block_id', attrs: ['purged_count'], lists: [] },
  // #5057 — `UndoResult` carries two `OpRef`s, and the two runners' device ids
  // differ, so the shape names only the two op_type fields.
  undo_page_op: {
    idKey: HEADED_ID_KEY,
    attrs: ['reversed_op_type', 'new_op_type', 'is_redo'],
    lists: [],
  },
  // #5057 — the undo family all answer `UndoResult`, singly or in a list, so
  // they share one shape. On a redo, `reversed_op_type` names the UNDO ROW it
  // was handed rather than the op it re-applies.
  undo_op: {
    idKey: HEADED_ID_KEY,
    attrs: ['reversed_op_type', 'new_op_type', 'is_redo'],
    lists: [],
  },
  undo_ops: {
    idKey: HEADED_ID_KEY,
    attrs: ['reversed_op_type', 'new_op_type', 'is_redo'],
    lists: [],
  },
  revert_ops: {
    idKey: HEADED_ID_KEY,
    attrs: ['reversed_op_type', 'new_op_type', 'is_redo'],
    lists: [],
  },
  redo_page_op: {
    idKey: HEADED_ID_KEY,
    attrs: ['reversed_op_type', 'new_op_type', 'is_redo'],
    lists: [],
  },
  // #5057 — a COUNT envelope over a list; the per-op detail rides in
  // `results`, which the snapshot and the two counts pin between them.
  restore_page_to_op: {
    idKey: HEADED_ID_KEY,
    attrs: ['ops_reverted', 'non_reversible_skipped'],
    lists: [],
  },
  // A LIST of the same shape: one headed row per `UndoResult`, in the order
  // the group reversed them.
  undo_page_group: {
    idKey: HEADED_ID_KEY,
    attrs: ['reversed_op_type', 'new_op_type', 'is_redo'],
    lists: [],
  },
  // #3830 — the two `property_definitions` writers answer with the row, so
  // their shape is `PROPERTY_DEF_TOKEN`'s attributes read off a response.
  create_property_def: { idKey: 'key', attrs: PROPERTY_DEF_ATTRS, lists: [] },
  update_property_def_options: { idKey: 'key', attrs: PROPERTY_DEF_ATTRS, lists: [] },
  // #5057 — the draft writers answer with `()`, so their whole record is the
  // refusal declaration plus a head naming which one ran. `flush_all_drafts`
  // adds the one field a caller can see: how many rows it CONSUMED, which
  // counts a draft dropped by a guard as well as one actually flushed.
  save_draft: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  delete_draft: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  flush_draft: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  flush_all_drafts: { idKey: HEADED_ID_KEY, attrs: ['flushed'], lists: [] },
  // #5057 — the trash-lifecycle batch trio answers with a COUNT envelope and
  // no row identity, so each is headed by its own command name. The counts are
  // what separates them from their single-block siblings: they report the whole
  // cohort the cascade reached, not the ids the caller listed.
  delete_blocks_by_ids: {
    idKey: HEADED_ID_KEY,
    attrs: ['deleted_count'],
    lists: ['affected_page_ids'],
  },
  restore_blocks_by_ids: { idKey: HEADED_ID_KEY, attrs: ['affected_count'], lists: [] },
  purge_blocks_by_ids: { idKey: HEADED_ID_KEY, attrs: ['affected_count'], lists: [] },
  // #5057 — the three batch COUNTERS answer with a bare number, which carries
  // no field to name it. The shape's single attribute names the scalar, so the
  // token reads `set_property_batch#updated=3` instead of exposing a synthetic
  // key. See `projectReturn`.
  set_property_batch: { idKey: HEADED_ID_KEY, attrs: ['updated'], lists: [] },
  set_todo_state_batch: { idKey: HEADED_ID_KEY, attrs: ['updated'], lists: [] },
  add_tags_by_ids: { idKey: HEADED_ID_KEY, attrs: ['tagged'], lists: [] },
  // #5057 — the two batch commands that answer with a LIST OF ROWS. Each
  // element becomes its own row token in the order returned, so the returned
  // ORDER is pinned as well as the rows.
  create_blocks_batch: {
    idKey: 'id',
    attrs: ['block_type', 'content', 'parent_id', 'position'],
    lists: [],
    rows: 'blocks',
  },
  move_blocks_batch: {
    idKey: 'block_id',
    attrs: ['new_parent_id', 'new_position'],
    lists: [],
    rows: 'moves',
  },
  // #5140 Phase 3a — the same row list as `create_blocks_batch`: the root copy,
  // then its descendants in pre-order, so the order is pinned with the rows.
  duplicate_block: {
    idKey: 'id',
    attrs: ['block_type', 'content', 'parent_id', 'position'],
    lists: [],
    rows: 'blocks',
  },
  // #5140 Phase 3b — the same row list again: the pages and tags the paste
  // created, then the pasted blocks in document order, so the placement after
  // the anchor and the nesting are pinned with the rows.
  paste_blocks: {
    idKey: 'id',
    attrs: ['block_type', 'content', 'parent_id', 'position'],
    lists: [],
    rows: 'blocks',
  },
  // #5140 Phase 4a — a COUNT envelope with no row identity. `moved` is left
  // out: which blocks of a reordered group move is the backend's
  // longest-in-order choice, and the mock only approximates it; the snapshot
  // pins where they land. The names and warnings are grammar the mock does not
  // model.
  apply_page_source: {
    idKey: HEADED_ID_KEY,
    attrs: ['created', 'edited', 'deleted'],
    lists: [],
  },
  // #5057 — five writers whose table is OUTSIDE the snapshot's five arrays
  // (`peer_refs`, `app_settings`, `property_definitions`), so what they wrote is
  // pinned by the read that follows them in the same fixture rather than by the
  // settled state. Each answers with `()`.
  delete_peer_ref: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  update_peer_name: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  set_peer_address: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  set_reminder_settings: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  // #4549 — one `app_settings` row, observed by `get_sync_relay_settings`.
  set_sync_relay_settings: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  delete_property_def: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  // #5057 — the two attachment writers that need no blob. `attachments` is
  // outside the snapshot's five arrays, so `list_attachments` observes them.
  delete_attachment: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  rename_attachment: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  // #5057 — the bytes writer, whose `AttachmentRow` is HALF stack-local: `id`,
  // `fs_path` and `content_hash` are minted per stack and `created_at` is a
  // clock read. The shape names the four fields the caller supplied and the
  // row stores verbatim.
  add_attachment_with_bytes: {
    idKey: HEADED_ID_KEY,
    attrs: ['block_id', 'filename', 'mime_type', 'size_bytes'],
    lists: [],
  },
  // #5057 — op-log maintenance. One count, deterministically zero on this
  // corpus: the cutoff is `now()` minus a window with a seven-day floor, and
  // every op a fixture replays is minted during the run.
  compact_op_log_cmd: { idKey: HEADED_ID_KEY, attrs: ['ops_deleted'], lists: [] },
  // #5057 — the joiner half of pairing answers `()`; the `list_peer_refs` step
  // beside it observes the `unpaired_by_peer_at_ms` clear.
  confirm_pairing: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  // #5057 — the host half, empty for a different reason: `PairingInfo` HAS two
  // fields and neither is nameable — `passphrase` is generated per stack and
  // `qr_svg` is rendered from it. The `list_peer_refs` step beside it observes
  // the same `unpaired_by_peer_at_ms` clear.
  start_pairing: { idKey: HEADED_ID_KEY, attrs: [], lists: [] },
  // #5057 — `page_aliases` is outside the snapshot's five arrays too, so a
  // `get_page_aliases` step observes the table. The RETURN is its own
  // evidence: a LIST OF BARE STRINGS naming the rows actually INSERTED, which
  // is narrower than what the caller passed.
  set_page_aliases: { idKey: HEADED_ID_KEY, attrs: ['inserted'], lists: [] },
  // #5057 — the two space creators answer with the new block's id, which the
  // relabel maps to its canonical label like any other id-valued attribute.
  create_space: { idKey: HEADED_ID_KEY, attrs: ['space_id'], lists: [] },
  create_page_in_space: { idKey: HEADED_ID_KEY, attrs: ['page_id'], lists: [] },
  // #5057 — the batch mover answers with a bare count, so its single
  // attribute names the scalar. The count is narrower than the input list: an
  // id that no longer resolves to a live block is skipped, not refused.
  move_blocks_to_space: { idKey: HEADED_ID_KEY, attrs: ['moved'], lists: [] },
}

/** Mirror of `project_return`: the row token, then one arrow per list element. */
export function projectReturn(command: string, response: unknown): string[] {
  const shape = RETURN_SHAPE[command]
  if (!shape) {
    throw new Error(
      `conformance op '${command}' has no RETURN_SHAPE entry in the TS runner (add it here ` +
        `and the matching arm in conformance_command.rs)`,
    )
  }
  // A headed shape has no id column: the head is the command name and the
  // attributes are read off the row beside it. Applied PER ROW rather than to
  // the response as a whole, because a list return of headed rows
  // (`undo_page_group`) needs the head on each element — `idToken` reads
  // `row[idKey]` and renders a missing-id token for a row that has none.
  // A row that is not an object has no such field — `null` (a `()` return)
  // declares no attributes and renders as the bare head, while a bare COUNT is
  // the whole return value, so the shape's single attribute names it.
  const headRow = (value: unknown): Record<string, unknown> => {
    const isObject = value !== null && typeof value === 'object'
    if (!isObject && shape.attrs.length > 1) {
      throw new Error(
        `conformance op '${command}' returns a scalar, so at most ONE attribute can name it; ` +
          `RETURN_SHAPE declares ${JSON.stringify(shape.attrs)}`,
      )
    }
    const raw: Record<string, unknown> = isObject
      ? (value as Record<string, unknown>)
      : shape.attrs[0] !== undefined
        ? { [shape.attrs[0]]: value }
        : {}
    return shape.idKey === HEADED_ID_KEY ? { ...raw, [HEADED_ID_KEY]: command } : raw
  }

  // A LIST return is a list of ROWS: one row token per element, in the order
  // the command returned them.
  const list =
    shape.rows !== undefined ? (response as Record<string, unknown>)[shape.rows] : response
  if (Array.isArray(list)) {
    return list.map((row) => idToken(headRow(row), shape.idKey, shape.attrs))
  }
  const row = headRow(response)
  const out = [idToken(row, shape.idKey, shape.attrs)]
  for (const field of shape.lists) {
    const ids = row[field]
    if (!Array.isArray(ids)) continue
    for (const id of ids) out.push(`${field}->${typeof id === 'string' ? id : '<not-a-string>'}`)
  }
  return out
}

/** A declaration key as the wire string it must be; `null` when absent. */
function declared(
  at: string,
  step: CommandOpStep,
  key: 'expect_error' | 'expect_code',
): string | null {
  const raw: unknown = (step as unknown as Record<string, unknown>)[key]
  if (raw == null) return null
  if (typeof raw !== 'string') {
    throw new Error(`${at}: \`${key}\` must be a wire string, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/**
 * The #3946 declaration discipline over a command outcome, mirror of
 * `check_declaration` in the Rust twin: both arms or neither, for the kind AND
 * for the `ValidationCode`.
 */
export function checkDeclaration(
  at: string,
  declaredKind: string | null,
  declaredCode: string | null,
  actualKind: string | null,
  actualCode: string | null,
): void {
  if (declaredKind === null && actualKind !== null) {
    throw new Error(
      `${at}: the command REFUSED with \`${actualKind}\`, and the op did not declare it. ` +
        `Add "expect_error": "${actualKind}" plus a "comment", or correct the op's args.`,
    )
  }
  if (declaredKind !== null && actualKind === null) {
    throw new Error(
      `${at}: the op declares "expect_error": "${declaredKind}" but the command SUCCEEDED.`,
    )
  }
  if (declaredKind !== null && actualKind !== null && declaredKind !== actualKind) {
    throw new Error(
      `${at}: the op declares "expect_error": "${declaredKind}" but the command refused ` +
        `with \`${actualKind}\`.`,
    )
  }
  if (declaredCode !== null && declaredKind !== 'validation') {
    throw new Error(
      `${at}: \`expect_code\` is a ValidationCode, so it accompanies "expect_error": ` +
        `"validation" only`,
    )
  }
  if (declaredCode === null && actualCode !== null) {
    throw new Error(
      `${at}: the refusal carries ValidationCode \`${actualCode}\`, and the op did not ` +
        `declare it. Add "expect_code": "${actualCode}".`,
    )
  }
  if (declaredCode !== null && actualCode === null) {
    throw new Error(
      `${at}: the op declares "expect_code": "${declaredCode}" but the refusal carries no code.`,
    )
  }
  if (declaredCode !== null && actualCode !== null && declaredCode !== actualCode) {
    throw new Error(
      `${at}: the op declares "expect_code": "${declaredCode}" but the refusal carries ` +
        `\`${actualCode}\`.`,
    )
  }
}

/**
 * Dispatch one `via: "command"` op, enforce its declarations, and build its
 * record with raw ids (the caller relabels once the canonical order is final).
 *
 * Only an `AppError`-shaped throw counts as a refusal — the discipline of
 * `runQuerySteps`: a bare `Error` is a MOCK BUG and re-throws.
 */
export function runCommandOp(
  step: CommandOpStep,
  args: Record<string, unknown>,
  fixtureName: string,
): CommandRecord {
  if (typeof step.name !== 'string') {
    throw new Error(
      `fixture '${fixtureName}': a \`via: "command"\` op (command '${step.command}') must ` +
        `carry a string \`name\`, or its record cannot be named in any diff`,
    )
  }
  const at = `fixture '${fixtureName}' op '${step.name}' (command '${step.command}')`
  let returns: string[] = []
  let error: string | null = null
  let code: string | null = null
  try {
    returns = projectReturn(step.command, dispatch(step.command, args))
  } catch (err) {
    const rejection = err as Record<string, unknown> | null
    const kind = rejection?.['kind']
    if (typeof kind !== 'string') throw err
    error = kind
    const raw = rejection?.['code']
    code = typeof raw === 'string' ? raw : null
  }
  checkDeclaration(
    at,
    declared(at, step, 'expect_error'),
    declared(at, step, 'expect_code'),
    error,
    code,
  )
  return { name: step.name, returns, error, code }
}
