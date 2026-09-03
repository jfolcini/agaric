/**
 * Type-drift regression guard for #4414.
 *
 * A wrapper module that hand-declares a type the generator already owns can
 * drift from it silently — `AttachmentRow` did, missing
 * `content_hash?: string | null`, because nothing checked the two
 * declarations against each other. Re-exporting instead of redeclaring makes
 * that impossible by construction, so what needs guarding is the
 * reintroduction of a duplicate. The `Expect<IsEqual<…>>` block below is that
 * guard, and it is a COMPILE-TIME assertion checked by `tsc`
 * (`npm run typecheck`), not by vitest, which strips types without checking
 * them — which is why both are run.
 *
 * It pins the four wrapper types that still exist. `AttachmentRow` and
 * `SyncSessionInfo` are no longer among them: #4411/#4413 retired
 * `attachments.ts` and `sync.ts` outright, so their callers use the generated
 * types directly and there is no second declaration left to diverge.
 */
import { describe, expect, it } from 'vitest'

import type {
  ImportResult as WireImportResult,
  OpRef as WireOpRef,
  PropertyRow as WirePropertyRow,
  UndoResult as WireUndoResult,
} from '@/lib/bindings'
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

// If any of these three wrapper modules ever goes back to a hand-declared
// duplicate that diverges from `bindings.ts` — adding, dropping, or
// retyping a field — one of these lines stops compiling and `tsc` fails,
// naming this file. `export`ed (never imported elsewhere) so
// `noUnusedLocals` doesn't flag them — an exported type is not "unused".
export type _PropertyRowMatchesWire = Expect<IsEqual<PropertyRow, WirePropertyRow>>
export type _ImportResultMatchesWire = Expect<IsEqual<ImportResult, WireImportResult>>
export type _OpRefMatchesWire = Expect<IsEqual<OpRef, WireOpRef>>
export type _UndoResultMatchesWire = Expect<IsEqual<UndoResult, WireUndoResult>>

describe('@/lib/tauri/* wrapper types match the generated bindings (#4414)', () => {
  it('PropertyRow re-export carries value_bool — native boolean storage', () => {
    // Typed as the WRAPPER's re-exported `PropertyRow`. If the wrapper ever
    // redeclares the interface without `value_bool`, `value_bool: null`
    // becomes an EXCESS PROPERTY and `tsc` rejects the literal — a second,
    // more directly-readable compile-time trip-wire alongside the
    // `Expect<IsEqual<…>>` block above.
    const row: PropertyRow = {
      key: 'k',
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }
    expect(row.value_bool).toBeNull()
  })
})
