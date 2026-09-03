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
 * `SyncSessionInfo` directly). `attachments.ts` itself was deleted the same
 * way in #4411 (`addAttachmentWithBytes` was a PURE passthrough), so
 * `AttachmentRow` has no wrapper type left to pin either — callers use the
 * generated `AttachmentRow` directly. `AttachmentRow` drifted silently
 * before the fix — missing `content_hash?: string | null` — because nothing
 * checked the two declarations against each other.
 *
 * The fix (re-export instead of redeclare) makes drift impossible BY
 * CONSTRUCTION, so there is no runtime behaviour to assert for most of these
 * — the type itself no longer has an independent existence to diverge. The
 * guard that actually catches a regression (someone reintroducing a
 * hand-declared duplicate) is the `Expect<IsEqual<…>>` block below: it is a
 * COMPILE-TIME assertion, checked by `tsc` (`npm run typecheck`, and the
 * pre-push / CI type-check), not by vitest — vitest strips types without
 * checking them. That split is why both are run (see the PR verification
 * notes); the `it()` below exists to give the guard a described home and to
 * smoke-check a re-exported value still works at runtime, the way
 * `AttachmentRow`'s did before its wrapper was retired.
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
    // redeclares the interface without `value_bool` again, `value_bool: null`
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
