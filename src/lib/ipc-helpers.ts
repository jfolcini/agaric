/**
 * The floor of the `@/lib/tauri` → `bindings.ts` migration (#2927, #4413).
 *
 * `src/lib/tauri/` exists to be deleted. These functions can't move to a
 * bare `commands.*` call site because each carries real logic the generated
 * binding does not (and, for two of them, cannot) express on its own:
 *
 *  - `cancelledError` / `withAbort` — no IPC at all; a client-side
 *    abort-signal → `AppError` bridge used by `searchBlocks`.
 *  - `restoreAllDeletedInSpace` / `purgeAllDeletedInSpace` — a chunked drain
 *    over the `listTrash` cursor chain plus `PartialPurgeError`, ~120 LOC of
 *    genuine logic (see their doc comments below).
 *  - `importMarkdown` / `startSync` — channel-based (`Channel<T>` progress
 *    plumbing), not simple request/response.
 *  - `readAttachment` — the sanctioned raw-`invoke` seam: a raw-response
 *    Tauri command can't carry a `specta::Type`, so it has no generated
 *    `commands.*` binding at all.
 *
 * They live here, not in `src/lib/tauri/`, so the directory whose entire
 * purpose is to be deleted doesn't end up permanently un-deletable.
 */

import { Channel, invoke } from '@tauri-apps/api/core'

import { isAppError, unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  AppError,
  BlockRow,
  BulkTrashResponse,
  ImportProgressUpdate,
  ImportResult,
  PageResponse,
  SyncProgressUpdate,
  SyncSessionInfo,
  VaultFile,
} from '@/lib/bindings'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { toSpaceScope } from '@/lib/space-scope'

// ---------------------------------------------------------------------------
// Client-side abort plumbing (no IPC)
// ---------------------------------------------------------------------------

/**
 * Build the same `{ kind: 'cancelled', message }` shape the backend
 * emits for `AppError::Cancelled`, so `isCancellation(err)` (from
 * `lib/app-error.ts`) discriminates client-side aborts the same way
 * it discriminates server-side cancellations.
 */
export function cancelledError(reason = 'aborted client-side'): AppError {
  return { kind: 'cancelled', message: reason }
}

/**
 * Wrap a typed IPC promise so it rejects with a `cancelled`-kind
 * `AppError` if the supplied `AbortSignal` fires. The underlying IPC
 * is NOT cancelled server-side (Tauri 2 limitation); the wrapper is
 * a client-side stop-waiting primitive. Use alongside
 * `useGenerationGuard` if the consumer also needs to discard the
 * value when it eventually arrives.
 *
 * If `signal` is undefined or already aborted, the behaviour is
 * unchanged from the bare promise (already-aborted short-circuits
 * before the IPC even starts; undefined passes through verbatim).
 */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return promise
  if (signal.aborted) {
    // The IPC promise was already constructed (args are eager); it's now
    // orphaned by the early reject below. Swallow its eventual settlement so a
    // later rejection doesn't surface as an unhandled promise rejection.
    promise.catch(() => {})
    return Promise.reject(cancelledError(signal.reason?.toString()))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(cancelledError(signal.reason?.toString()))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Trash: chunked drain over the whole space (real logic, not a passthrough)
// ---------------------------------------------------------------------------

/**
 * Backend cap on the `block_ids` batch accepted by `restore_blocks_by_ids`
 * / `purge_blocks_by_ids` (`MAX_BATCH_BLOCK_IDS` in
 * `src-tauri/src/commands/mod.rs`). Mirrored here so
 * {@link restoreAllDeletedInSpace} / {@link purgeAllDeletedInSpace} can
 * chunk an arbitrarily large trash into backend-accepted batches instead
 * of surfacing `AppError::Validation` for a busy trash. Exported (#3885)
 * so tests of the chunked path can build a fixture sized off this
 * constant — `MAX_TRASH_BATCH_IDS + 1` — instead of a magic literal that
 * silently stops meaning "one over the batch cap" if this value ever
 * changes.
 */
export const MAX_TRASH_BATCH_IDS = 1000

/**
 * Collect every trash-root id belonging to `spaceId` by walking
 * `list_trash`'s cursor chain to completion — independent of whatever page
 * / cursor position the caller's own UI list happens to be showing.
 * Shared by {@link restoreAllDeletedInSpace} and
 * {@link purgeAllDeletedInSpace}.
 */
async function collectAllTrashRootIds(spaceId: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (;;) {
    const page: PageResponse<BlockRow> = unwrap(
      await commands.listTrash(cursor, PAGINATION_LIMIT, toSpaceScope(spaceId)),
    )
    ids.push(...page.items.map((b: BlockRow) => b.id))
    if (!page.has_more || page.next_cursor == null) break
    cursor = page.next_cursor
  }
  return ids
}

/**
 * Restore every soft-deleted block in `spaceId`.
 *
 * #2544 — the backend's `restore_all_deleted` command is intentionally
 * NOT called here: it takes no `space_id` and would resurrect trashed
 * blocks across EVERY space, not just the one the Trash view displays
 * (and the one its confirmation dialog counted). Instead this drains the
 * already space-scoped `list_trash` cursor chain for `spaceId` (mirroring
 * the "ignore the frontend's own load-more frontier, act on everything in
 * trash" semantics `purge_all_deleted` used to provide, just space-scoped)
 * and hands the resulting root ids to `restore_blocks_by_ids` — the same
 * space-safe path the per-row and multi-select restore actions already
 * use — chunked to the backend's batch-size cap.
 */
export async function restoreAllDeletedInSpace(spaceId: string): Promise<BulkTrashResponse> {
  const ids = await collectAllTrashRootIds(spaceId)
  let affectedCount = 0
  // #3838 made this chunk loop depend on the ORDER of `ids`, where it
  // previously did not. `restore_blocks_by_ids` now REFUSES a live id, and
  // one chunk's #1884 upward ancestor walk can make a later chunk's trash
  // root live — which would abort the whole remaining restore.
  //
  // It is unreachable today, and the reason is worth writing down because it
  // lives in another crate: `list_trash` orders `deleted_at DESC`
  // (`agaric-store/src/pagination/trash.rs`), an ancestor trash root always
  // carries a LATER `deleted_at` than a descendant trash root, and an equal
  // `deleted_at` disqualifies the descendant from being a root at all. So an
  // ancestor is always in an EARLIER chunk than anything it would revive.
  // If that ordering ever changes, this loop breaks silently — nothing here
  // would notice.
  for (let i = 0; i < ids.length; i += MAX_TRASH_BATCH_IDS) {
    const resp = unwrap(await commands.restoreBlocksByIds(ids.slice(i, i + MAX_TRASH_BATCH_IDS)))
    affectedCount += resp.affected_count
  }
  return { affected_count: affectedCount }
}

/**
 * Thrown by {@link purgeAllDeletedInSpace} when a chunk fails part-way
 * through the drain. #3835 — each chunk is its own backend IMMEDIATE
 * transaction, so any chunk before the failing one has ALREADY committed:
 * a plain rethrow of the chunk's error discarded that count, so a
 * partially-completed "empty trash" surfaced to the caller as a pure
 * failure with no sign that most of it succeeded. `affectedCount` carries
 * what actually landed so a caller can tell "removed 0 of N, nothing
 * happened" apart from "removed N-1 of N, one chunk away from done" and
 * word its toast (and its retry) accordingly. `cause` is the triggering
 * error (also available via the standard `Error.cause`), preserved so
 * existing `.message`-based assertions on the underlying failure still see
 * it — this wraps the failure, it does not replace it.
 */
export class PartialPurgeError extends Error {
  readonly affectedCount: number

  constructor(affectedCount: number, cause: unknown) {
    super(PartialPurgeError.messageOf(cause), { cause })
    this.name = 'PartialPurgeError'
    this.affectedCount = affectedCount
  }

  /**
   * The `isAppError` arm is the REALISTIC one, not a defensive extra:
   * `unwrap` throws the raw `{ kind, message }` AppError envelope, which is
   * a plain object and NOT an `Error`. Without it every IPC-originated
   * chunk failure — i.e. the whole reason this class exists — would take
   * the `String(cause)` arm and degrade to `"[object Object]"`, silently
   * discarding the backend's message. `cause instanceof Error` only ever
   * held for locally-constructed errors, which is exactly the shape the
   * tests happened to use.
   */
  private static messageOf(cause: unknown): string {
    if (isAppError(cause)) return cause.message
    if (cause instanceof Error) return cause.message
    return String(cause)
  }
}

/**
 * Permanently purge every soft-deleted block in `spaceId`. Irreversible.
 *
 * #2544 — mirrors {@link restoreAllDeletedInSpace}'s rationale: the
 * backend's `purge_all_deleted` command is unscoped and would destroy
 * trash in every space, not just the active one shown (and confirmed) by
 * the Trash view's "Empty trash" dialog. Scoped here the same way, via
 * `purge_blocks_by_ids`.
 *
 * #3835 — a chunk failing part-way through (e.g. `InvalidOperation` from a
 * concurrently-restored id, or any other backend rejection) throws
 * {@link PartialPurgeError} instead of the bare chunk error, carrying
 * whatever `affectedCount` the EARLIER, already-committed chunks purged, so
 * that progress is not discarded from the caller's view of the outcome.
 */
export async function purgeAllDeletedInSpace(spaceId: string): Promise<BulkTrashResponse> {
  const ids = await collectAllTrashRootIds(spaceId)
  let affectedCount = 0
  for (let i = 0; i < ids.length; i += MAX_TRASH_BATCH_IDS) {
    try {
      const resp = unwrap(await commands.purgeBlocksByIds(ids.slice(i, i + MAX_TRASH_BATCH_IDS)))
      affectedCount += resp.affected_count
    } catch (err) {
      throw new PartialPurgeError(affectedCount, err)
    }
  }
  return { affected_count: affectedCount }
}

// ---------------------------------------------------------------------------
// Channel-based commands
// ---------------------------------------------------------------------------

/**
 * Import a Logseq/Markdown file. Creates a page from the filename and
 * blocks from content.
 *
 * `spaceId` — required. The created page is stamped
 * with `space = ?spaceId` inside the same backend transaction as the
 * `CreateBlock` op, so an imported page can never exist without its
 * space property. Callers must pass the active space's ULID; the
 * import button must stay disabled while the space store is not
 * bootstrapped (no active space) so this never receives an empty
 * string.
 *
 * `onProgress` (#128) — optional. When
 * supplied, the backend streams per-block progress over a
 * `Channel<ImportProgressUpdate>`: one `started` event, one `progress`
 * per block, then one `complete` after the import transaction commits.
 * A failed import emits `started` (+ any `progress`) but no `complete`,
 * so a consumer that never sees `complete` should treat it as failed.
 * The channel is always created (mirroring `startSync`) even when no
 * callback is passed; events are simply discarded.
 */
export async function importMarkdown(
  content: string,
  filename: string | undefined,
  spaceId: string,
  onProgress?: (update: ImportProgressUpdate) => void,
  vaultFiles?: VaultFile[] | null,
): Promise<ImportResult> {
  const channel = new Channel<ImportProgressUpdate>()
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri `Channel` is an IPC primitive, not a DOM EventTarget; it only exposes an `onmessage` setter (no `addEventListener`)
  if (onProgress) channel.onmessage = onProgress
  // #1925 — `vaultFiles` carries the referenced attachment bytes the backend
  // ingests and rewrites to `attachment:<id>`. Only the `webkitdirectory`
  // vault picker can supply siblings (see DataSettingsTab); a single-file
  // import has no siblings and omits it. Defaults to `null` ⇒ exactly the
  // pre-#1925 behaviour for every caller that does not pass it.
  return unwrap(
    await commands.importMarkdown(content, filename ?? null, spaceId, vaultFiles ?? null, channel),
  )
}

/** Start a sync session with a known peer. */
export async function startSync(
  peerId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<SyncSessionInfo> {
  const channel = new Channel<SyncProgressUpdate>()
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri `Channel` is an IPC primitive, not a DOM EventTarget; it only exposes an `onmessage` setter (no `addEventListener`)
  if (onProgress) channel.onmessage = onProgress
  return unwrap(await commands.startSync(peerId, channel))
}

// ---------------------------------------------------------------------------
// Sanctioned raw invoke
// ---------------------------------------------------------------------------

/**
 * Read an attachment's raw bytes by ID.
 *
 * #2654: the `read_attachment` Tauri command returns a raw-byte
 * `tauri::ipc::Response`, so `invoke` resolves an `ArrayBuffer` with zero JSON
 * encoding — no multi-MB `number[]` parse on the main thread. Because a
 * raw-response command cannot carry a `specta::Type`, it has no generated
 * `commands.*` binding; this is the sanctioned raw-`invoke` seam. A backend
 * error rejects the promise with the serialized `AppError`, matching every
 * other IPC helper's throw shape.
 */
export async function readAttachment(attachmentId: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>('read_attachment', { attachmentId })
  return new Uint8Array(buffer)
}
