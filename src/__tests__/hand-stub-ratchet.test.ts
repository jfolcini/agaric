/**
 * #4668 — the hand-stubbed `invoke` ratchet.
 *
 * Counts test files that hand the INVOKE mock a literal — `.mockResolvedValue(…)`
 * / `.mockRejectedValue(…)` (and the `Once` variants) on `vi.mocked(invoke)` or
 * an alias bound to it. That literal is what nothing checks against the Rust
 * surface: a component can be green for years against a response the backend
 * never produces. Route a file's last literal through `mockInvokeCommands` and
 * it drops out, because that seam is typed against the generated return types.
 *
 * Not the count of files containing `vi.mocked(invoke)`: `mockInvokeCommands`
 * returns an implementation you still install, so a migrated file keeps that
 * string and the number could only fall by deleting tests.
 *
 * The baseline is the FILE SET, not its size. A count alone is satisfied by a
 * PR that migrates one file and adds a hand-stub in another — the arithmetic
 * that hid a regression behind a win. Naming the files also makes the
 * migration auditable in the diff, and it is what
 * `scripts/tauri-import-baseline.json` does for the sibling ratchet.
 *
 * The match is textual, so the source goes through `js-scanner.mjs`'s
 * `stripComments` first (the sanctioned tokenizer) and the walk is fenced to
 * `*.test.ts(x)`: strings survive `stripComments` by design, and
 * `helpers/invoke.ts` names the expression in an error message.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped JS helper, the repo's sanctioned tokenizer (#3991)
import { stripComments } from '../../scripts/lib/js-scanner.mjs'

/**
 * Files that hand the invoke mock a literal because they SHOULD, keyed to why.
 *
 * Zero is not the target. These do not migrate — ever — so they are named
 * here rather than sitting in the backlog below pretending to be work.
 * A test needing an ARBITRARY response — a malformed payload, a command with
 * no binding to be typed against — is testing a shape the typed seam exists to
 * forbid, and routing it through that seam would destroy it.
 *
 * An IPC REJECTION is not in this class: `mockInvokeCommands` takes a handler
 * that rejects or throws, so those migrate like any other stub.
 */
const DELIBERATE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'src/__tests__/strict-invoke.test.ts':
    'the seam under test. Its counted stub is a catch-all resolving `undefined`, ' +
    'installed to prove that an explicit stub overrides `strictInvokeFallback` — ' +
    'the case the whole design turns on. Expressing it through `mockInvokeCommands` ' +
    'would test that helper instead of the fallback it is asserting about.',
  'src/lib/__tests__/ipc-helpers.test.ts':
    'the `readAttachment` describe ONLY. `read_attachment` returns a raw-byte ' +
    '`tauri::ipc::Response`, which cannot carry a `specta::Type`, so it has NO ' +
    'generated binding (`src/lib/ipc-helpers.ts:15-17`) and is not a key of ' +
    '`CommandReturns` — the typed seam cannot name it, and the stub is an ' +
    '`ArrayBuffer` no generated type would describe. The rest of this file ' +
    '(`startSync`, `importMarkdown`) has generated bindings and SHOULD migrate; ' +
    'the exception is file-granular only because one stub pins the whole file in ' +
    'the live set.',
}

/**
 * Files still to migrate onto `mockInvokeCommands`. Not exceptions — just not
 * done yet. Delete an entry when you migrate its file; the test fails in both
 * directions, so a stale entry cannot hide a win and a new one cannot slip in.
 */
const MIGRATION_BACKLOG: readonly string[] = [
  'src/__tests__/viewTransition.test.tsx',
  'src/components/PageBrowser/__tests__/editors.test.tsx',
  'src/components/agenda/__tests__/AgendaFilterBuilder.test.tsx',
  'src/components/agenda/__tests__/GlobalDateControls.test.tsx',
  'src/components/agenda/__tests__/StatusPanel.test.tsx',
  'src/components/attachments/__tests__/AttachmentList.test.tsx',
  'src/components/backlink-filter/categories/__tests__/HasTagFilterForm.test.tsx',
  'src/components/block-tree/__tests__/use-block-auto-create-first-block.test.ts',
  'src/components/block-tree/__tests__/use-block-date-picker.test.ts',
  'src/components/block-tree/__tests__/use-block-multi-select.test.ts',
  'src/components/block-tree/__tests__/use-block-properties.test.ts',
  'src/components/block-tree/__tests__/use-block-slash-commands.test.ts',
  'src/components/block-tree/__tests__/use-block-tree-event-listeners.test.ts',
  'src/components/block-tree/__tests__/use-block-zoom-empty-seed.test.ts',
  'src/components/block-tree/use-block-slash-commands/__tests__/useSlashCommandProperty.test.ts',
  'src/components/dialogs/__tests__/QuickCaptureDialog.test.tsx',
  'src/components/editor/__tests__/BlockPropertyDrawer.test.tsx',
  'src/components/editor/__tests__/BlockTree.a11y.test.tsx',
  'src/components/editor/__tests__/BlockTree.test.tsx',
  'src/components/editor/__tests__/StaticBlock.test.tsx',
  'src/components/filters/__tests__/TagComposer.test.tsx',
  'src/components/filters/__tests__/TagFilterPanel.test.tsx',
  'src/components/history/__tests__/HistoryView.test.tsx',
  'src/components/journal/__tests__/JournalCalendarDropdown.test.tsx',
  'src/components/journal/__tests__/JournalControls.test.tsx',
  'src/components/pages/__tests__/PageBrowserBatchToolbar.test.tsx',
  'src/components/pages/__tests__/PagePropertyTable.test.tsx',
  'src/components/pages/__tests__/ViewDispatcher.test.tsx',
  'src/components/peers/__tests__/DeviceManagement.test.tsx',
  'src/components/peers/__tests__/PeerListItem.test.tsx',
  'src/components/properties/__tests__/PropertyDefinitionsList.test.tsx',
  'src/components/properties/__tests__/PropertyRowEditor.test.tsx',
  'src/components/properties/__tests__/PropertyValuePicker.test.tsx',
  'src/components/properties/__tests__/TagValuePicker.test.tsx',
  'src/components/query/__tests__/QueryResult.test.tsx',
  'src/components/templates/__tests__/CompactionCard.test.tsx',
  'src/components/templates/__tests__/TemplatesView.test.tsx',
  'src/lib/__tests__/agenda-filters.test.ts',
  'src/lib/__tests__/export-graph.test.ts',
  'src/lib/__tests__/property-keys-cache.test.ts',
  'src/lib/__tests__/property-save-utils.test.ts',
  'src/lib/__tests__/property-values-cache.test.ts',
  'src/lib/__tests__/slash-commands.test.ts',
  'src/lib/__tests__/tauri.test.ts',
  'src/lib/__tests__/template-utils.test.ts',
  'src/stores/__tests__/page-blocks.crud.test.ts',
  'src/stores/__tests__/page-blocks.load-reconcile.test.ts',
  'src/stores/__tests__/page-blocks.move-reparent.test.ts',
  'src/stores/__tests__/page-blocks.optimistic-invariants.test.ts',
  'src/stores/__tests__/page-blocks.paste-prefetch.test.ts',
  'src/stores/__tests__/page-blocks.reorder.test.ts',
  'src/stores/__tests__/page-blocks.split-indent.test.ts',
  'src/stores/__tests__/page-blocks.undo-registry.test.ts',
  'src/stores/__tests__/resolve.test.ts',
]

// Anchored at the alias: only a stub call that immediately follows it counts,
// so a `.mockResolvedValue(` on a different mock nearby cannot be attributed
// to invoke.
const STUB_CALL = /^\s*\.mock(?:Resolved|Rejected)Value(?:Once)?\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out)
    } else if (/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Does this file stub the INVOKE mock specifically with a literal? */
function handStubsInvoke(source: string): boolean {
  if (!source.includes('vi.mocked(invoke)')) return false
  const aliases = new Set<string>(['vi.mocked(invoke)'])
  for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*vi\.mocked\(invoke\)/g)) {
    if (m[1] != null) aliases.add(m[1])
  }
  for (const alias of aliases) {
    let from = source.indexOf(alias)
    while (from !== -1) {
      if (STUB_CALL.test(source.slice(from + alias.length))) return true
      from = source.indexOf(alias, from + 1)
    }
  }
  return false
}

describe('#4668 hand-stubbed invoke ratchet', () => {
  it('the set of files handing invoke a literal only shrinks', () => {
    const live = new Set(
      walk('src').filter((f) => handStubsInvoke(stripComments(readFileSync(f, 'utf8')))),
    )
    const baseline = new Set([...Object.keys(DELIBERATE_EXCEPTIONS), ...MIGRATION_BACKLOG])

    const added = [...live].filter((f) => !baseline.has(f)).toSorted()
    const stale = [...baseline].filter((f) => !live.has(f)).toSorted()

    // One assertion, not two: a migrate-one-add-one PR drifts BOTH ways at
    // once, and a second `expect` would never run to report the half that
    // motivates listing the files at all.
    expect(
      { added, stale },
      '`added` — new file(s) hand `vi.mocked(invoke)` a literal, which nothing checks ' +
        'against the Rust surface. Stub through `mockInvokeCommands` ' +
        '(src/__tests__/helpers/invoke.ts) instead; it is typed against the generated ' +
        'command return types. If the test genuinely needs a shape the backend cannot ' +
        'produce, add it to DELIBERATE_EXCEPTIONS above WITH its reason.\n' +
        '`stale` — baseline entr(ies) no longer hand invoke a literal. Delete them from ' +
        'whichever list holds them — MIGRATION_BACKLOG if migrated, DELIBERATE_EXCEPTIONS ' +
        'if the file was renamed or deleted; a stale entry lets the set drift back up and ' +
        'hides the migration that earned it.',
    ).toEqual({ added: [], stale: [] })
  })
})
