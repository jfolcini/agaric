/**
 * Type-drift regression guard for #4414.
 *
 * `src/lib/tauri/{attachments,properties,import,history}.ts` used to
 * hand-declare `AttachmentRow`, `PropertyRow`, `ImportResult`, `OpRef`, and
 * `UndoResult` as local `interface`s instead of re-exporting the generated
 * `@/lib/bindings` types (a sixth, `SyncSessionInfo` in `sync.ts`, got the
 * same fix, but `sync.ts` itself was later deleted entirely — #4411/#4413
 * retired both its wrapper functions — so there is no wrapper type left to
 * pin there; `commands.startSync`'s callers use the generated
 * `SyncSessionInfo` directly). `AttachmentRow` drifted silently — missing
 * `content_hash?: string | null` — because nothing checked the two
 * declarations against each other.
 *
 * The fix (re-export instead of redeclare) makes drift impossible BY
 * CONSTRUCTION, so there is no runtime behaviour to assert here — the type
 * itself no longer has an independent existence to diverge. The guard that
 * actually catches a regression (someone reintroducing a hand-declared
 * duplicate) is the `Expect<IsEqual<…>>` block below: it is a COMPILE-TIME
 * assertion, checked by `tsc` (`npm run typecheck`, and the pre-push /
 * CI type-check), not by vitest — vitest strips types without checking them.
 * That split is why both are run (see the PR verification notes) and why
 * this file's `it()` block exists mainly to give the guard a described home
 * and to smoke-check the re-exported values still work at runtime.
 */
import { describe, expect, it } from 'vitest'

import type {
  AttachmentRow as WireAttachmentRow,
  ImportResult as WireImportResult,
  OpRef as WireOpRef,
  PropertyRow as WirePropertyRow,
  UndoResult as WireUndoResult,
} from '@/lib/bindings'
import type { AttachmentRow } from '@/lib/tauri/attachments'
import type { OpRef, UndoResult } from '@/lib/tauri/history'
import type { ImportResult } from '@/lib/tauri/import'
import type { PropertyRow } from '@/lib/tauri/properties'

// Standard type-testing utility (distinguishes structurally-equal-but-not-
// identical types better than a naive mutual-`extends` check — it catches an
// optional-vs-required field or an extra/missing member that mutual
// assignability alone can miss).
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// If any of these four wrapper modules ever goes back to a hand-declared
// duplicate that diverges from `bindings.ts` — adding, dropping, or
// retyping a field — one of these lines stops compiling and `tsc` fails,
// naming this file. `export`ed (never imported elsewhere) so
// `noUnusedLocals` doesn't flag them — an exported type is not "unused".
export type _AttachmentRowMatchesWire = Expect<IsEqual<AttachmentRow, WireAttachmentRow>>
export type _PropertyRowMatchesWire = Expect<IsEqual<PropertyRow, WirePropertyRow>>
export type _ImportResultMatchesWire = Expect<IsEqual<ImportResult, WireImportResult>>
export type _OpRefMatchesWire = Expect<IsEqual<OpRef, WireOpRef>>
export type _UndoResultMatchesWire = Expect<IsEqual<UndoResult, WireUndoResult>>

describe('@/lib/tauri/* wrapper types match the generated bindings (#4414)', () => {
  it('AttachmentRow re-export carries content_hash — the field that drifted', () => {
    // This object literal is typed as the WRAPPER's re-exported
    // `AttachmentRow`. If the wrapper ever redeclares the interface without
    // `content_hash` again, `content_hash: null` becomes an EXCESS PROPERTY
    // and `tsc` rejects the literal — a second, more directly-readable
    // compile-time trip-wire alongside the `Expect<IsEqual<…>>` block above.
    const row: AttachmentRow = {
      id: 'B1',
      block_id: 'B1',
      filename: 'a.png',
      mime_type: 'image/png',
      size_bytes: 1,
      fs_path: '/x',
      created_at: 0,
      content_hash: null,
    }
    expect(row.content_hash).toBeNull()
  })
})
