/**
 * Type-drift regression guard for #4414.
 *
 * A wrapper module that hand-declares a type the generator already owns can
 * drift from it silently — `AttachmentRow` did, missing
 * `content_hash?: string | null`, because nothing checked the two
 * declarations against each other. Re-exporting instead of redeclaring makes
 * that impossible by construction, so what needs guarding is the
 * reintroduction of a duplicate. The `Expect<IsEqual<…>>` line below is that
 * guard, and it is a COMPILE-TIME assertion checked by `tsc`
 * (`npm run typecheck`), not by vitest, which strips types without checking
 * them — which is why both are run.
 *
 * It pins the one wrapper type that still exists. `AttachmentRow`,
 * `SyncSessionInfo`, `OpRef`, `UndoResult` and `PropertyRow` are no longer
 * among them: #4411/#4413 retired `attachments.ts`, `sync.ts`, `history.ts`
 * and `properties.ts` outright, so their callers use the generated types
 * directly and there is no second declaration left to diverge.
 */
import { describe, expect, it } from 'vitest'

import type { ImportResult as WireImportResult } from '@/lib/bindings'
import type { ImportResult } from '@/lib/tauri/import'

// Standard type-testing utility (distinguishes structurally-equal-but-not-
// identical types better than a naive mutual-`extends` check — it catches an
// optional-vs-required field or an extra/missing member that mutual
// assignability alone can miss).
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// If this wrapper module ever goes back to a hand-declared duplicate that
// diverges from `bindings.ts` — adding, dropping, or retyping a field — this
// line stops compiling and `tsc` fails, naming this file. `export`ed (never
// imported elsewhere) so `noUnusedLocals` doesn't flag it — an exported type
// is not "unused".
export type _ImportResultMatchesWire = Expect<IsEqual<ImportResult, WireImportResult>>

describe('@/lib/tauri/* wrapper types match the generated bindings (#4414)', () => {
  it('ImportResult re-export carries the wire fields', () => {
    // Typed as the WRAPPER's re-exported `ImportResult`. If the wrapper ever
    // redeclares the interface, a field mismatch makes this literal an EXCESS
    // PROPERTY error — a second, more directly-readable compile-time trip-wire
    // alongside the `Expect<IsEqual<…>>` line above.
    const result: ImportResult = {
      page_title: 'Page',
      blocks_created: 1,
      properties_set: 0,
      warnings: [],
    }
    expect(result.blocks_created).toBe(1)
  })
})
